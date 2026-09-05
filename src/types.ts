export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected";

export interface Asset {
  symbol: string;
  name: string;
  price: number;
  updatedAt: string;
}

export interface PricePoint {
  symbol: string;
  price: number;
  ts: string;
}

export interface Order {
  id: string;
  userId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: number;
  filledQuantity: number;
  limitPrice: number | null;
  status: OrderStatus;
  reservedCash: number;
  reservedShares: number;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

export interface Fill {
  id: string;
  orderId: string;
  userId: string;
  symbol: string;
  side: Side;
  quantity: number;
  price: number;
  ts: string;
}

export type LedgerEventType =
  | "USER_CREATED"
  | "ORDER_PLACED"
  | "ORDER_FILL"
  | "ORDER_CANCELLED"
  | "RESERVATION_RELEASE"
  | "PRICE_TICK";

export interface LedgerEvent {
  id: string;
  type: LedgerEventType;
  userId: string | null;
  symbol: string | null;
  payload: Record<string, unknown>;
  ts: string;
}

export interface Holding {
  symbol: string;
  quantity: number;
  costBasis: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
}

export interface PortfolioSnapshot {
  userId: string;
  cash: number;
  reservedCash: number;
  holdings: Holding[];
  totalMarketValue: number;
  totalCostBasis: number;
  totalUnrealizedPnl: number;
  asOf: string;
}

export interface CalculatorResult {
  symbol: string;
  usdAmount: number;
  price: number;
  shares: number;
}
