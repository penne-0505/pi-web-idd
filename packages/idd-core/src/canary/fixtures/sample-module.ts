export interface Order {
  id: string;
  amount: number;
  paid: boolean;
}

/** the amounts of the paid orders, summed; an unpaid order is left out */
export function paidTotal(orders: Order[]): number {
  return orders.filter((o) => o.paid).reduce((sum, o) => sum + o.amount, 0);
}

/** the mean amount of the paid orders; 0 when none is paid */
export function averagePaid(orders: Order[]): number {
  const paid = orders.filter((o) => o.paid);
  return paid.length === 0 ? 0 : paidTotal(orders) / paid.length;
}

/** one line for an order: its id, its amount and whether it is paid */
export function labelOf(order: Order): string {
  return `${order.id}: ${order.amount} ${order.paid ? "paid" : "open"}`;
}
