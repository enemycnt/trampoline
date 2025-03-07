import { UserOperation } from '@account-abstraction/utils';
import { createSlice } from '@reduxjs/toolkit';
import { RootState } from '.';
import KeyringService from '../services/keyring';
import ProviderBridgeService from '../services/provider-bridge';
import { createBackgroundAsyncThunk } from './utils';
import { EthersTransactionRequest } from '../services/types';

export type TransactionState = {
  transactionRequest?: EthersTransactionRequest;
  transactionsRequest?: EthersTransactionRequest[];
  modifiedTransactionRequest?: EthersTransactionRequest;

  requestOrigin?: string;
  userOperationRequest?: Partial<UserOperation>;
  unsignedUserOperation?: UserOperation;
};

export const initialState: TransactionState = {
  transactionsRequest: undefined,
  transactionRequest: undefined,
  userOperationRequest: undefined,
  unsignedUserOperation: undefined,
};

type SigningReducers = {
  sendTransactionRequest: (
    state: TransactionState,
    {
      payload,
    }: {
      payload: {
        transactionRequest: EthersTransactionRequest;
        origin: string;
      };
    }
  ) => TransactionState;
  sendTransactionsRequest: (
    state: TransactionState,
    {
      payload,
    }: {
      payload: {
        transactionsRequest: EthersTransactionRequest[];
        origin: string;
      };
    }
  ) => TransactionState;
  setModifyTransactionRequest: (
    state: TransactionState,
    {
      payload,
    }: {
      payload: EthersTransactionRequest | undefined;
    }
  ) => TransactionState;
  sendUserOperationRquest: (
    state: TransactionState,
    { payload }: { payload: UserOperation }
  ) => TransactionState;
  setUnsignedUserOperation: (
    state: TransactionState,
    { payload }: { payload: UserOperation }
  ) => TransactionState;
  clearTransactionState: (state: TransactionState) => TransactionState;
};

const transactionsSlice = createSlice<
  TransactionState,
  SigningReducers,
  'signing'
>({
  name: 'signing',
  initialState,
  reducers: {
    sendTransactionRequest: (
      state,
      {
        payload: { transactionRequest, origin },
      }: {
        payload: {
          transactionRequest: EthersTransactionRequest;
          origin: string;
        };
      }
    ) => {
      return {
        ...state,
        transactionRequest: transactionRequest,
        requestOrigin: origin,
      };
    },
    sendTransactionsRequest: (
      state,
      {
        payload: { transactionsRequest, origin },
      }: {
        payload: {
          transactionsRequest: EthersTransactionRequest[];
          origin: string;
        };
      }
    ) => {
      return {
        ...state,
        transactionsRequest: transactionsRequest,
        requestOrigin: origin,
      };
    },
    setModifyTransactionRequest: (
      state,
      {
        payload,
      }: {
        payload: EthersTransactionRequest | undefined;
      }
    ) => ({
      ...state,
      modifiedTransactionRequest: payload,
    }),
    sendUserOperationRquest: (
      state,
      { payload }: { payload: UserOperation }
    ) => ({
      ...state,
      userOperationRequest: payload,
    }),
    setUnsignedUserOperation: (
      state,
      { payload }: { payload: UserOperation }
    ) => ({
      ...state,
      unsignedUserOperation: payload,
    }),
    clearTransactionState: (state) => ({
      ...state,
      typedDataRequest: undefined,
      signDataRequest: undefined,
      transactionRequest: undefined,
      transactionsRequest: undefined,
      modifiedTransactionRequest: undefined,
      requestOrigin: undefined,
      userOperationRequest: undefined,
      unsignedUserOperation: undefined,
    }),
  },
});

export const {
  sendTransactionRequest,
  sendTransactionsRequest,
  setModifyTransactionRequest,
  sendUserOperationRquest,
  setUnsignedUserOperation,
  clearTransactionState,
} = transactionsSlice.actions;

export default transactionsSlice.reducer;

export const sendTransaction = createBackgroundAsyncThunk(
  'transactions/sendTransaction',
  async (
    { address, context }: { address: string; context?: any },
    { dispatch, extra: { mainServiceManager } }
  ) => {
    const keyringService = mainServiceManager.getService(
      KeyringService.name
    ) as KeyringService;

    const state = mainServiceManager.store.getState() as RootState;
    const unsignedUserOp = state.transactions.unsignedUserOperation;
    const origin = state.transactions.requestOrigin;

    if (unsignedUserOp) {
      const signedUserOp = await keyringService.signUserOpWithContext(
        address,
        unsignedUserOp,
        context
      );
      const txnHash = keyringService.sendUserOp(address, signedUserOp);

      dispatch(clearTransactionState());

      const providerBridgeService = mainServiceManager.getService(
        ProviderBridgeService.name
      ) as ProviderBridgeService;

      providerBridgeService.resolveRequest(origin || '', txnHash);
    }
  }
);

export const createUnsignedUserOp = createBackgroundAsyncThunk(
  'transactions/createUnsignedUserOp',
  async (
    { address, context }: { address: string; context?: any },
    { dispatch, extra: { mainServiceManager } }
  ) => {
    const keyringService = mainServiceManager.getService(
      KeyringService.name
    ) as KeyringService;

    const state = mainServiceManager.store.getState() as RootState;
    const transactionRequest = state.transactions.transactionRequest;

    if (transactionRequest) {
      const userOp = await keyringService.createUnsignedUserOp(
        address,
        transactionRequest,
        context
      );
      dispatch(setUnsignedUserOperation(userOp));
    }
  }
);

export const rejectTransaction = createBackgroundAsyncThunk(
  'transactions/rejectTransaction',
  async (address: string, { dispatch, extra: { mainServiceManager } }) => {
    dispatch(clearTransactionState());

    const requestOrigin = (mainServiceManager.store.getState() as RootState)
      .transactions.requestOrigin;

    const providerBridgeService = mainServiceManager.getService(
      ProviderBridgeService.name
    ) as ProviderBridgeService;

    providerBridgeService.rejectRequest(requestOrigin || '', '');
  }
);
