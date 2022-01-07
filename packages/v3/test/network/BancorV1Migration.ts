import Contracts from '../../components/Contracts';
import { DSToken, TokenGovernance, TestStandardPoolConverter } from '../../components/LegacyContracts';
import {
    IERC20,
    BancorV1Migration,
    MasterVault,
    NetworkSettings,
    TestBancorNetwork,
    TestPoolCollection,
    PendingWithdrawals,
    PoolToken
} from '../../typechain-types';
import { PPM_RESOLUTION } from '../../utils/Constants';
import { TokenData, TokenSymbol } from '../../utils/TokenData';
import { toPPM } from '../../utils/Types';
import { createPool, createSystem, createToken, TokenWithAddress } from '../helpers/Factory';
import { createLegacySystem } from '../helpers/LegacyFactory';
import { getBalance, getTransactionCost } from '../helpers/Utils';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

const INITIAL_RATE = { n: BigNumber.from(1), d: BigNumber.from(2) };
const MAX_DEVIATION = BigNumber.from(10_000);
const MINTING_LIMIT = BigNumber.from(10_000_000);
const MIN_LIQUIDITY = BigNumber.from(100_000);
const DEPOSIT_LIMIT = BigNumber.from(100_000_000);
const TOTAL_SUPPLY = BigNumber.from(1_000_000_000);
const DEPOSIT_AMOUNT = DEPOSIT_LIMIT.div(10);

describe('BancorV1Migration', () => {
    let deployer: SignerWithAddress;
    let provider: SignerWithAddress;

    let networkTokenGovernance: TokenGovernance;
    let govTokenGovernance: TokenGovernance;
    let govToken: IERC20;
    let network: TestBancorNetwork;
    let networkSettings: NetworkSettings;
    let networkToken: IERC20;
    let masterPoolToken: PoolToken;
    let basePoolToken: PoolToken;
    let pendingWithdrawals: PendingWithdrawals;
    let poolCollection: TestPoolCollection;
    let masterVault: MasterVault;
    let bancorV1Migration: BancorV1Migration;
    let converter: TestStandardPoolConverter;
    let poolToken: DSToken;
    let baseToken: TokenWithAddress;

    beforeEach(async () => {
        ({
            networkTokenGovernance,
            govTokenGovernance,
            govToken,
            network,
            networkSettings,
            networkToken,
            masterPoolToken,
            pendingWithdrawals,
            poolCollection,
            masterVault
        } = await createSystem());

        bancorV1Migration = await Contracts.BancorV1Migration.deploy(network.address);
    });

    const initLegacySystem = async (networkAmount: BigNumber, baseAmount: BigNumber, isNativeToken: boolean) => {
        baseToken = await createToken(new TokenData(isNativeToken ? TokenSymbol.ETH : TokenSymbol.TKN));

        ({ poolToken, converter } = await createLegacySystem(
            deployer,
            network,
            masterVault,
            networkToken,
            networkTokenGovernance,
            govTokenGovernance,
            baseToken
        ));

        await networkTokenGovernance.mint(deployer.address, TOTAL_SUPPLY);
        await networkToken.transfer(provider.address, networkAmount);

        basePoolToken = await createPool(baseToken, network, networkSettings, poolCollection);
        await networkSettings.setPoolMintingLimit(baseToken.address, MINTING_LIMIT);
        await poolCollection.setDepositLimit(baseToken.address, DEPOSIT_LIMIT);
        await poolCollection.setInitialRate(baseToken.address, INITIAL_RATE);
        await pendingWithdrawals.setLockDuration(0);

        await networkToken.connect(provider).approve(converter.address, networkAmount);
        if (!isNativeToken) {
            const token = await Contracts.TestERC20Token.attach(baseToken.address);
            await token.transfer(provider.address, baseAmount);
            await token.connect(provider).approve(converter.address, baseAmount);
        }

        await converter
            .connect(provider)
            .addLiquidity([networkToken.address, baseToken.address], [networkAmount, baseAmount], 1, {
                value: isNativeToken ? baseAmount : BigNumber.from(0)
            });
    };

    const verify = async (
        withdrawalFee: number,
        networkAmount: BigNumber,
        baseAmount: BigNumber,
        isNativeToken: boolean,
        percent: number
    ) => {
        const portionOf = (amount: BigNumber) => amount.mul(percent).div(100);
        const deductFee = (amount: BigNumber) => amount.sub(amount.mul(withdrawalFee).div(PPM_RESOLUTION));

        const prevProviderPoolTokenBalance = await getBalance(poolToken, provider.address);
        const prevConverterNetworkBalance = await getBalance(networkToken, converter.address);
        const prevConverterBaseBalance = await getBalance(baseToken, converter.address);
        const prevVaultNetworkBalance = await getBalance(networkToken, masterVault.address);
        const prevVaultBaseBalance = await getBalance(baseToken, masterVault.address);
        const prevPoolTokenSupply = await poolToken.totalSupply();

        const poolTokenAmount = portionOf(await getBalance(poolToken, provider.address));
        await poolToken.connect(provider).approve(bancorV1Migration.address, poolTokenAmount);
        await bancorV1Migration.connect(provider).migratePoolTokens(poolToken.address, poolTokenAmount);

        const currProviderPoolTokenBalance = await getBalance(poolToken, provider.address);
        const currConverterNetworkBalance = await getBalance(networkToken, converter.address);
        const currConverterBaseBalance = await getBalance(baseToken, converter.address);
        const currVaultNetworkBalance = await getBalance(networkToken, masterVault.address);
        const currVaultBaseBalance = await getBalance(baseToken, masterVault.address);
        const currPoolTokenSupply = await poolToken.totalSupply();

        expect(currProviderPoolTokenBalance).to.equal(prevProviderPoolTokenBalance.sub(poolTokenAmount));
        expect(currConverterNetworkBalance).to.equal(
            prevConverterNetworkBalance.sub(
                prevConverterNetworkBalance.mul(portionOf(baseAmount)).div(prevConverterBaseBalance)
            )
        );
        expect(currConverterBaseBalance).to.equal(prevConverterBaseBalance.sub(portionOf(baseAmount)));
        expect(currVaultNetworkBalance).to.equal(
            prevVaultNetworkBalance.add(prevVaultNetworkBalance.mul(portionOf(baseAmount)).div(prevVaultBaseBalance))
        );
        expect(currVaultBaseBalance).to.equal(prevVaultBaseBalance.add(portionOf(baseAmount)));
        expect(currPoolTokenSupply).to.equal(prevPoolTokenSupply.sub(poolTokenAmount));

        const prevProviderNetworkBalance = await getBalance(networkToken, provider);

        const masterPoolTokenAmount = await getBalance(masterPoolToken, provider.address);
        await masterPoolToken.connect(provider).approve(network.address, masterPoolTokenAmount);

        await network.connect(provider).initWithdrawal(masterPoolToken.address, masterPoolTokenAmount);

        const networkIds = await pendingWithdrawals.withdrawalRequestIds(provider.address);
        await govToken.connect(provider).approve(network.address, await getBalance(govToken, provider.address));
        await network.connect(provider).withdraw(networkIds[0]);

        const basePoolTokenAmount = await getBalance(basePoolToken, provider.address);
        await basePoolToken.connect(provider).approve(network.address, basePoolTokenAmount);
        await network.connect(provider).initWithdrawal(basePoolToken.address, basePoolTokenAmount);
        const baseIds = await pendingWithdrawals.withdrawalRequestIds(provider.address);

        const prevProviderBaseBalance = await getBalance(baseToken, provider);

        const res = await network.connect(provider).withdraw(baseIds[0]);

        let transactionCost = BigNumber.from(0);
        if (isNativeToken) {
            transactionCost = await getTransactionCost(res);
        }

        const currProviderNetworkBalance = await getBalance(networkToken, provider);
        const currProviderBaseBalance = await getBalance(baseToken, provider);

        expect(currProviderNetworkBalance).to.equal(
            prevProviderNetworkBalance.add(deductFee(portionOf(networkAmount)))
        );
        expect(currProviderBaseBalance.add(transactionCost)).to.equal(
            prevProviderBaseBalance.add(deductFee(portionOf(baseAmount)))
        );
    };

    const test = (
        withdrawalFeePercent: number,
        networkAmountM: number,
        baseAmountM: number,
        isNativeToken: boolean,
        percent: number
    ) => {
        const withdrawalFeePPM = toPPM(withdrawalFeePercent);
        const networkAmount = BigNumber.from(networkAmountM * 1_000_000);
        const baseAmount = BigNumber.from(baseAmountM * 1_000_000);

        describe(`withdrawal fee = ${withdrawalFeePercent}%`, () => {
            describe(`network amount = ${networkAmountM}M`, () => {
                describe(`base amount = ${baseAmountM}M`, () => {
                    describe(`base token = ${isNativeToken ? 'ETH' : 'ERC20'}`, () => {
                        beforeEach(async () => {
                            await networkSettings.setAverageRateMaxDeviationPPM(MAX_DEVIATION);
                            await networkSettings.setWithdrawalFeePPM(withdrawalFeePPM);
                            await networkSettings.setMinLiquidityForTrading(MIN_LIQUIDITY);

                            await initLegacySystem(networkAmount, baseAmount, isNativeToken);

                            if (isNativeToken) {
                                await network.deposit(baseToken.address, DEPOSIT_AMOUNT, { value: DEPOSIT_AMOUNT });
                            } else {
                                const token = await Contracts.TestERC20Token.attach(baseToken.address);
                                await token.approve(network.address, DEPOSIT_AMOUNT);

                                await network.deposit(baseToken.address, DEPOSIT_AMOUNT);
                            }
                        });

                        it(`verifies that the caller can migrate ${percent}% of its pool tokens`, async () => {
                            await verify(withdrawalFeePPM, networkAmount, baseAmount, isNativeToken, percent);
                        });
                    });
                });
            });
        });
    };

    before(async () => {
        [deployer, provider] = await ethers.getSigners();
    });

    describe('quick tests', () => {
        for (const withdrawalFeeP of [1, 5]) {
            for (const networkAmountM of [1, 5]) {
                for (const baseAmountM of [1, 5]) {
                    for (const isNativeToken of [false, true]) {
                        for (const percent of [10, 100]) {
                            test(withdrawalFeeP, networkAmountM, baseAmountM, isNativeToken, percent);
                        }
                    }
                }
            }
        }
    });

    describe('@stress tests', () => {
        for (const withdrawalFeeP of [1, 2.5, 5]) {
            for (const networkAmountM of [1, 2.5, 5]) {
                for (const baseAmountM of [1, 2.5, 5]) {
                    for (const isNativeToken of [false, true]) {
                        for (const percent of [10, 25, 50, 100]) {
                            test(withdrawalFeeP, networkAmountM, baseAmountM, isNativeToken, percent);
                        }
                    }
                }
            }
        }
    });
});