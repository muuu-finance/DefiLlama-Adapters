const sdk = require("@defillama/sdk");
const BigNumberJs = require("bignumber.js");
BigNumberJs.config({ EXPONENTIAL_AT: 1e9 })

const { BOOSTER_ADDRESS } = require("./constants");
const boosterABI = require("./abi/booster.json");
const registryABI = require("./abi/registry.json");

// from Kagla
const addressProviderABI = require("../kagla/abi/addressProvider.json");
const {
  ADDRESS_PROVIDER_ADDRESS,
  ZERO_ADDRESS,
  transformTokenAddress
} = require("../kagla/addresses");

// utils
const toBigNumberJsOrZero = (value) => {
  const bn = new BigNumberJs(value)
  return bn.isNaN() ? new BigNumberJs('0') : bn
}

// logics
/** Get Muuu's pools */
const getPools = async (block, chain) => {
  const poolLength = (await sdk.api.abi.call({
    target: BOOSTER_ADDRESS,
    abi: boosterABI["poolLength"],
    block,
    chain,
  })).output
  const pools = (await sdk.api.abi.multiCall({
    calls: [...Array(Number(poolLength))].map((_, i) => ({ target: BOOSTER_ADDRESS, params: i })),
    abi: boosterABI["poolInfo"],
    block,
    chain,
  })).output.filter(({ output }) => !output.shutdown).map(({ output }) => ({
    lptoken: output.lptoken,
    token: output.token,
    kglRewards: output.kglRewards,
    shutdown: output.shutdown
  }))
  return pools
}

/** Calcurate Kagla's lptokens holding ratios */
const calculateRatios = async (block, chain, pools) => {
  const depositTokenTotalSupplies = (await sdk.api.abi.multiCall({
    calls: pools.map(p => ({ target: p.token })),
    abi: "erc20:totalSupply",
    block,
    chain
  })).output.map(({ output }) => new BigNumberJs(output))
  const lptokenTotalSupplies = (await sdk.api.abi.multiCall({
    calls: pools.map(p => ({ target: p.lptoken })),
    abi: "erc20:totalSupply",
    block,
    chain
  })).output.map(({ output }) => new BigNumberJs(output))

  return depositTokenTotalSupplies.map((de, i) => de.dividedBy(lptokenTotalSupplies[i]))
}

/** Get Kagla's pools used in Muuu */
const getKaglaPoolsInfo = async (block, chain, lptokenAddresses) => {
  const registryAddress = (await sdk.api.abi.call({
    target: ADDRESS_PROVIDER_ADDRESS,
    abi: addressProviderABI["get_registry"],
    block,
    chain,
  })).output
  const kaglaPoolAddresses = (await sdk.api.abi.multiCall({
    calls: lptokenAddresses.map(address => ({ target: registryAddress, params: address })),
    abi: registryABI["get_pool_from_lp_token"],
    block,
    chain,
  })).output.map(({ output }) => output)

  const poolCoinsArray = (await sdk.api.abi.multiCall({
    calls: kaglaPoolAddresses.map(address => ({ target: registryAddress, params: address })),
    abi: registryABI["get_coins"],
    block,
    chain,
  })).output.map(({ output }) => output.filter(address => address !== ZERO_ADDRESS))
  const poolBalancesArray = (await sdk.api.abi.multiCall({
    calls: kaglaPoolAddresses.map(address => ({ target: registryAddress, params: address })),
    abi: registryABI["get_balances"],
    block,
    chain,
  })).output.map(({ output }) => output)

  return {
    poolCoinsArray,
    poolBalancesArray
  }
}

// main
const tvl = async (_timestamp, block, chain) => {
  const pools = await getPools(block, chain)

  const [ratios, { poolCoinsArray, poolBalancesArray }] = await Promise.all([
    calculateRatios(block, chain, pools),
    getKaglaPoolsInfo(block, chain, pools.map(p => p.lptoken))
  ])
  const poolOwnBalancesArray = poolBalancesArray.map((poolBalances, i) => poolBalances.map(b => (new BigNumberJs(b).multipliedBy(ratios[i])).toString()))

  const balanceBNRecord = poolCoinsArray.reduce(
    (result, coins, poolIndex) => 
      coins.reduce((coinsResult, coin, coinIndex) => {
        const balance = toBigNumberJsOrZero(poolOwnBalancesArray[poolIndex][coinIndex])
        const transformedCoin = transformTokenAddress(coin)
        const exisitingBalance = coinsResult[transformedCoin]
        if(!transformedCoin) return coinsResult
        if(!exisitingBalance)
            return { ...coinsResult, [transformedCoin]: balance }
        return { ...coinsResult, [transformedCoin]: exisitingBalance.plus(balance) }
      }, result),
    {}
  )
  const result = Object.keys(balanceBNRecord).reduce((result, key) => {
    return {
      ...result,
      [key]: key.startsWith("0x")
        ? balanceBNRecord[key]
        : balanceBNRecord[key].shiftedBy(-18)
    }
  }, {})

  return result
}

async function staking(timestamp, block, chainBlocks){
  const allCoins = {}
    const muuuStakedSupply = await sdk.api.erc20.totalSupply({
      target: "0xB2ae0CF4819f2BE89574D3dc46D481cf80C7a255", // muuuRewardsAddress,
      block: chainBlocks['astar'],
      chain: 'astar'
    });

    sdk.util.sumSingleBalance(allCoins, "0x6a2d262D56735DbA19Dd70682B39F6bE9a931D98", muuuStakedSupply.output)
    return allCoins
}

module.exports = {
  tvl,
  // staking
}
