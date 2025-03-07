import { UserOperation } from '@account-abstraction/utils';
import {
  BaseAccountAPI,
  BaseApiParams,
} from '@account-abstraction/sdk/dist/src/BaseAccountAPI';
import { TransactionDetailsForUserOp } from '@account-abstraction/sdk/dist/src/TransactionDetailsForUserOp';
import { MessageSigningRequest } from '../../Background/redux-slices/signing';
import { HttpRpcClient } from '@account-abstraction/sdk';

export abstract class AccountApiType extends BaseAccountAPI {
  abstract serialize: () => Promise<object>;

  abstract createUnsignedUserOpWithContext(
    info: TransactionDetailsForUserOp,
    preTransactionConfirmationContext?: any
  ): Promise<UserOperation>;

  /** sign a message for the use */
  abstract signMessage: (
    request?: MessageSigningRequest,
    context?: any
  ) => Promise<string>;

  abstract signUserOpWithContext(
    userOp: UserOperation,
    postTransactionConfirmationContext?: any
  ): Promise<UserOperation>;
}

export interface AccountApiParamsType<T, S> extends BaseApiParams {
  context?: T;
  deserializeState?: S;
  bundler: HttpRpcClient;
}

export type AccountImplementationType = new (
  params: AccountApiParamsType<any, any>
) => AccountApiType;
