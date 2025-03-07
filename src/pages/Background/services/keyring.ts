import { keyringUnlocked, Vault, vaultUpdate } from '../redux-slices/keyrings';
import BaseService, { BaseServiceCreateProps } from './base';
import MainServiceManager from './main';
import { ServiceLifecycleEvents } from './types';
import * as encryptor from '@metamask/browser-passworder';
import { Provider } from '@ethersproject/providers';
import { BigNumber, ethers } from 'ethers';
import { AccountApiType } from '../../Account/account-api/types';
import {
  AccountImplementations,
  ActiveAccountImplementation,
} from '../constants';
import { HttpRpcClient, PaymasterAPI } from '@account-abstraction/sdk';
import { MessageSigningRequest } from '../redux-slices/signing';
import { AccountBalance } from '../types/account';
import { DomainName, URI } from '../types/common';
import { EVMNetwork } from '../types/network';
import { EthersTransactionRequest } from './types';
import { UserOperation } from '@account-abstraction/utils';
import { resolveProperties } from 'ethers/lib/utils.js';

interface Events extends ServiceLifecycleEvents {
  createPassword: string;
}

type KeyringSerialisedState = {
  type: string;
  address: string;
  data: any;
};

export type KeyringServiceCreateProps = {
  initialState?: Vault;
  provider: string;
  bundler: string;
  entryPointAddress: string;
} & BaseServiceCreateProps;

export default class KeyringService extends BaseService<Events> {
  keyrings: {
    [address: string]: AccountApiType;
  };
  vault?: string;
  password?: string;
  encryptionKey?: string;
  encryptionSalt?: string;
  provider: Provider;
  bundler?: HttpRpcClient;
  paymasterAPI?: PaymasterAPI;

  constructor(
    readonly mainServiceManager: MainServiceManager,
    provider: string,
    readonly bundlerUrl: string,
    readonly entryPointAddress: string,
    vault?: string
  ) {
    super();
    this.keyrings = {};
    this.provider = new ethers.providers.JsonRpcBatchProvider(provider);
    this.vault = vault;
  }

  init = async () => {
    const net = await this.provider.getNetwork();

    const chainId = net.chainId;

    let bundlerRPC;
    try {
      bundlerRPC = new ethers.providers.JsonRpcProvider(this.bundlerUrl);
    } catch (e) {
      throw new Error(
        `Bundler network is not connected on url ${this.bundlerUrl}`
      );
    }

    if (bundlerRPC) {
      const supportedEntryPoint = await bundlerRPC.send(
        'eth_supportedEntryPoints',
        []
      );
      if (!supportedEntryPoint.includes(this.entryPointAddress)) {
        throw new Error(
          `Bundler network doesn't support entryPoint ${this.entryPointAddress}`
        );
      }
    }

    const code = await this.provider.getCode(this.entryPointAddress);
    if (code === '0x')
      throw new Error(`Entrypoint not deployed at ${this.entryPointAddress}`);

    this.bundler = new HttpRpcClient(
      this.bundlerUrl,
      this.entryPointAddress,
      chainId
    );
  };

  async unlockVault(
    password?: string,
    encryptionKey?: string,
    encryptionSalt?: string
  ): Promise<{ [address: string]: AccountApiType }> {
    if (!this.vault) throw new Error('No vault to restore');

    let vault: any;

    if (password) {
      const result = await encryptor.decryptWithDetail(password, this.vault);
      vault = result.vault;
      this.password = password;
      this.encryptionKey = result.exportedKeyString;
      this.encryptionSalt = result.salt;
    } else {
      const parsedEncryptedVault = JSON.parse(this.vault);

      if (encryptionSalt !== parsedEncryptedVault.salt) {
        throw new Error('Encryption key and salt provided are expired');
      }

      const key = await encryptor.importKey(encryptionKey || '');
      vault = await encryptor.decryptWithKey(key, parsedEncryptedVault);

      this.encryptionKey = encryptionKey;
      this.encryptionSalt = encryptionSalt;
    }

    await Promise.all(vault.map(this._restoreKeyring));
    return this.keyrings;
  }

  /**
   * Restore Keyring Helper
   *
   * Attempts to initialize a new keyring from the provided serialized payload.
   * On success, returns the resulting keyring instance.
   *
   * @param {object} serialized - The serialized keyring.
   * @returns {Promise<Keyring|undefined>} The deserialized keyring or undefined if the keyring type is unsupported.
   */
  _restoreKeyring = async (
    serialized: KeyringSerialisedState
  ): Promise<AccountApiType | undefined> => {
    const { address, type, data } = serialized;

    const keyring = await this._newKeyring(address, type, data);

    this.keyrings[address] = keyring;

    return keyring;
  };

  /**
   * Instantiate, initialize and return a new keyring
   *
   * The keyring instantiated is of the given `type`.
   *
   * @param {string} type - The type of keyring to add.
   * @param {object} data - The data to restore a previously serialized keyring.
   * @returns {Promise<Keyring>} The new keyring.
   */
  async _newKeyring(
    address: string,
    type: string,
    data: any
  ): Promise<AccountApiType> {
    const account = new AccountImplementations[type]({
      provider: this.provider,
      bundler: this.bundler!,
      entryPointAddress: this.entryPointAddress,
      paymasterAPI: this.paymasterAPI,
      deserializeState: data,
    });

    await account.init();

    return account;
  }

  /**
   * Clear Keyrings
   *
   * Deallocates all currently managed keyrings and accounts.
   * Used before initializing a new vault.
   */

  /* eslint-disable require-await */
  clearKeyrings = async (): Promise<void> => {
    // clear keyrings from memory
    this.keyrings = {};
  };

  registerEventListeners = () => {};

  removeEventListeners = () => {};

  updateStore = () => {};

  createPassword = async (password: string) => {
    this.password = password;
    await this.persistAllKeyrings();
    this.keyringUnlocked();
  };

  keyringUnlocked = () => {
    this.mainServiceManager.store.dispatch(keyringUnlocked());
  };

  persistAllKeyrings = async () => {
    if (!this.password && !this.encryptionKey) {
      throw new Error(
        'Cannot persist vault without password and encryption key'
      );
    }

    const serializedKeyrings: KeyringSerialisedState[] = await Promise.all(
      Object.values(this.keyrings).map(async (keyring) => {
        const [address, data] = await Promise.all([
          await keyring.getAccountAddress(),
          keyring.serialize(),
        ]);
        return { type: ActiveAccountImplementation, address, data };
      })
    );

    let vault: string;

    if (this.password) {
      const { vault: newVault, exportedKeyString } =
        await encryptor.encryptWithDetail(this.password, serializedKeyrings);
      vault = newVault;
      this.encryptionKey = exportedKeyString;
      this.encryptionSalt = JSON.parse(newVault).salt;
    } else {
      const key = await encryptor.importKey(this.encryptionKey || '');
      const vaultJSON = await encryptor.encryptWithKey(key, serializedKeyrings);
      vaultJSON.salt = this.encryptionSalt;
      vault = JSON.stringify(vaultJSON);
    }

    this.mainServiceManager.store.dispatch(
      vaultUpdate({
        vault,
        encryptionKey: this.encryptionKey,
        encryptionSalt: this.encryptionSalt,
      })
    );
  };

  addAccount = async (
    implementation: string,
    context?: any
  ): Promise<string> => {
    const account = new AccountImplementations[implementation]({
      provider: this.provider,
      bundler: this.bundler!,
      entryPointAddress: this.entryPointAddress,
      context,
      paymasterAPI: this.paymasterAPI,
    });
    await account.init();
    const address = await account.getAccountAddress();
    if (address === ethers.constants.AddressZero)
      throw new Error(
        `EntryPoint getAccountAddress returned error and returned address ${ethers.constants.AddressZero}, check factory contract is properly deployed.`
      );
    this.keyrings[address] = account;
    await this.persistAllKeyrings();
    return account.getAccountAddress();
  };

  getAccountData = async (
    address: string,
    activeNetwork: EVMNetwork
  ): Promise<{
    accountDeployed: boolean;
    minimumRequiredFunds: string;
    balances?: {
      [assetSymbol: string]: AccountBalance;
    };
    ens?: {
      name?: DomainName;
      avatarURL?: URI;
    };
  }> => {
    const response: {
      accountDeployed: boolean;
      minimumRequiredFunds: string;
      balances?: {
        [assetSymbol: string]: AccountBalance;
      };
      ens?: {
        name?: DomainName;
        avatarURL?: URI;
      };
    } = {
      accountDeployed: false,
      minimumRequiredFunds: '0',
      balances: undefined,
      ens: undefined,
    };
    const code = await this.provider.getCode(address);
    if (code !== '0x') response.accountDeployed = true;

    const keyring = this.keyrings[address];

    response.minimumRequiredFunds = ethers.utils.formatEther(
      BigNumber.from(
        await keyring.estimateCreationGas(await keyring.getRequiredFactoryData())
      )
    );

    const balance = await this.provider.getBalance(address);

    response.balances = {
      [activeNetwork.baseAsset.symbol]: {
        address: '0x',
        assetAmount: {
          asset: {
            symbol: activeNetwork.baseAsset.symbol,
            name: activeNetwork.baseAsset.name,
          },
          amount: ethers.utils.formatEther(balance),
        },
        network: activeNetwork,
        retrievedAt: Date.now(),
        dataSource: 'custom',
      },
    };

    return response;
  };

  personalSign = async (
    address: string,
    context: any,
    request?: MessageSigningRequest
  ): Promise<string> => {
    const keyring = this.keyrings[address];

    if (!keyring) throw new Error('No keyring for the address found');

    return keyring.signMessage(context, request);
  };

  callAccountApi = async (
    address: string,
    functionName: string,
    args: any[] = []
  ) => {
    const keyring = this.keyrings[address] as any;

    if (typeof keyring[functionName] !== 'function') {
      throw new Error(`Account api not found: ${functionName}`);
    }

    return keyring[functionName](...args);
  };

  signUserOpWithContext = async (
    address: string,
    userOp: UserOperation,
    context?: any
  ): Promise<UserOperation> => {
    const keyring = this.keyrings[address];

    return keyring.signUserOpWithContext(userOp, context);
  };

  sendUserOp = async (
    address: string,
    userOp: UserOperation
  ): Promise<string | null> => {
    if (this.bundler) {
      const userOpHash = await this.bundler.sendUserOpToBundler(userOp);
      const keyring = this.keyrings[address];
      return await keyring.getUserOpReceipt(userOpHash);
    }
    return null;
  };

  createUnsignedUserOp = async (
    address: string,
    transaction: EthersTransactionRequest,
    context?: any
  ): Promise<UserOperation> => {
    const keyring = this.keyrings[address];
    const userOp = await resolveProperties(
      await keyring.createUnsignedUserOpWithContext(
        {
          target: transaction.to,
          data: transaction.data
            ? ethers.utils.hexConcat([transaction.data])
            : '0x',
          value: transaction.value
            ? ethers.BigNumber.from(transaction.value)
            : undefined,
          gasLimit: transaction.gasLimit,
          maxFeePerGas: transaction.maxFeePerGas,
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
        },
        context
      )
    );

    userOp.nonce = ethers.BigNumber.from(userOp.nonce).toHexString();
    userOp.callGasLimit = ethers.BigNumber.from(
      userOp.callGasLimit
    ).toHexString();
    userOp.verificationGasLimit = ethers.BigNumber.from(
      userOp.verificationGasLimit
    ).toHexString();
    userOp.preVerificationGas = ethers.BigNumber.from(
      userOp.preVerificationGas
    ).toHexString();
    userOp.maxFeePerGas = ethers.BigNumber.from(
      userOp.maxFeePerGas
    ).toHexString();
    userOp.maxPriorityFeePerGas = ethers.BigNumber.from(
      userOp.maxPriorityFeePerGas
    ).toHexString();

    const gasParameters = await this.bundler?.estimateUserOpGas(
      await keyring.signUserOp(userOp)
    );

    const estimatedGasLimit = ethers.BigNumber.from(
      gasParameters?.callGasLimit
    );
    const estimateVerificationGasLimit = ethers.BigNumber.from(
      gasParameters?.verificationGasLimit
    );
    const estimatePreVerificationGas = ethers.BigNumber.from(
      gasParameters?.preVerificationGas
    );

    userOp.callGasLimit = estimatedGasLimit.gt(
      ethers.BigNumber.from(userOp.callGasLimit)
    )
      ? estimatedGasLimit.toHexString()
      : userOp.callGasLimit;

    userOp.verificationGasLimit = estimateVerificationGasLimit.gt(
      ethers.BigNumber.from(userOp.verificationGasLimit)
    )
      ? estimateVerificationGasLimit.toHexString()
      : userOp.verificationGasLimit;

    userOp.preVerificationGas = estimatePreVerificationGas.gt(
      ethers.BigNumber.from(userOp.preVerificationGas)
    )
      ? estimatePreVerificationGas.toHexString()
      : userOp.preVerificationGas;

    return userOp;
  };

  static async create({
    mainServiceManager,
    initialState,
    provider,
    bundler,
    entryPointAddress,
  }: KeyringServiceCreateProps): Promise<KeyringService> {
    if (!mainServiceManager)
      throw new Error('mainServiceManager is needed for Keyring Servie');

    const keyringService = new KeyringService(
      mainServiceManager,
      provider,
      bundler,
      entryPointAddress,
      initialState?.vault
    );

    await keyringService.init();

    if (initialState?.encryptionKey && initialState?.encryptionSalt) {
      await keyringService.unlockVault(
        undefined,
        initialState?.encryptionKey,
        initialState?.encryptionSalt
      );
    }

    return keyringService;
  }

  _startService = async (): Promise<void> => {
    this.registerEventListeners();
  };

  _stopService = async (): Promise<void> => {
    this.removeEventListeners();
  };
}
