export type LoginOptions = {
  userId: string;
  userPassword: string;
  validateWithBalance?: boolean;
};

export type BuyLottoOptions = {
  gameCount: number;
};

export type BuyLottoResponse = {
  loginYn?: string;
  result?: {
    resultCode?: string;
    resultMsg?: string;
  };
  [key: string]: unknown;
};

export type BuyPension720Options = {
  gameCount: number;
};

export type BuyPension720Response = {
  requestedGameCount: number;
  selectedGameCount: number;
  orderNo: string | null;
};
