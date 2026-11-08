import { Transaction, UserProfile } from '../repo/types';

let idCounter = 0;
function uid() {
  return `txn-${++idCounter}`;
}

function dateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const GROCERS = ['Harvest Market', 'Corner Grocer', 'Greenleaf Grocers', 'FreshMart', 'BulkBarn Club'];
const RESTAURANTS = ['Casa Verde Grill', 'Golden Grill', 'Bean & Brew', 'Slice Society', 'Sushi Palace', 'Daily Crumb Bakery', 'Tuscan Table', 'Patty Shack', 'Noodle House'];
const DELIVERY = ['DashDish Delivery', 'Rider Eats', 'QuickBite Delivery'];
const RIDESHARE = ['CityCab', 'GoRide'];
const GAS = ['Harbor Fuel', 'Northside Fuel', 'Ridgeway Gas'];
const SHOPPING = ['ParcelPoint Online', 'Bullseye Goods', 'VoltBox Electronics', 'ValueMart', 'Nordhaus Home'];
const HEALTH = ['Corner Pharmacy', 'WellCare Pharmacy', "Dr. Smith's Office", 'Clearview Labs'];

export const userProfile: UserProfile = {
  name: 'Alex Johnson',
  monthlyIncome: 3200,
  balance: 2000,
  paydayOfMonth: 1,
};

function generateMonthTransactions(year: number, month: number, today: Date): Transaction[] {
  const monthDate = new Date(year, month - 1, 1);
  if (monthDate > today) return [];

  const daysInMonth = new Date(year, month, 0).getDate();
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;
  const lastDay = isCurrentMonth ? today.getDate() : daysInMonth;

  const txns: Transaction[] = [];

  const addTxn = (day: number, t: Omit<Transaction, 'id' | 'date'>) => {
    const d = Math.min(day, lastDay);
    if (day > lastDay) return;
    txns.push({ id: uid(), date: dateStr(year, month, d), ...t });
  };

  // --- Recurring ---
  // Salary
  addTxn(1, { merchant: 'Employer Direct Deposit', category: 'income', amount: 3200, method: 'bank', recurring: true });
  // Rent
  addTxn(2, { merchant: 'Sunrise Apartments', category: 'rent', amount: -1200, method: 'bank', recurring: true });
  // Electricity (5th)
  addTxn(5, { merchant: 'City Electric Co.', category: 'utilities', amount: -(110 + rand(0, 30)), method: 'card', recurring: true });
  // Internet (8th)
  addTxn(8, { merchant: 'FastNet Broadband', category: 'utilities', amount: -60, method: 'paypal', recurring: true });
  // Phone (10th)
  addTxn(10, { merchant: 'Mobile Plus', category: 'utilities', amount: -55, method: 'card', recurring: true });
  // Netflix (12th)
  addTxn(12, { merchant: 'StreamBox', category: 'subscriptions', amount: -15.99, method: 'card', recurring: true });
  // Spotify (13th)
  addTxn(13, { merchant: 'Tunewave', category: 'subscriptions', amount: -9.99, method: 'card', recurring: true });

  // --- Groceries (4-5 times) ---
  [3, 10, 17, 24, 29].forEach((day, i) => {
    if (i === 4 && Math.random() > 0.5) return;
    addTxn(day, {
      merchant: GROCERS[rand(0, GROCERS.length - 1)],
      category: 'groceries',
      amount: -(70 + rand(0, 60)),
      method: 'card',
      recurring: false,
    });
  });

  // --- Restaurants (5-6 times) ---
  [4, 7, 11, 15, 20, 26].forEach((day) => {
    addTxn(day, {
      merchant: RESTAURANTS[rand(0, RESTAURANTS.length - 1)],
      category: 'restaurants',
      amount: -(12 + rand(0, 48)),
      method: Math.random() > 0.5 ? 'card' : 'paypal',
      recurring: false,
    });
  });

  // --- Food Delivery (2-3 times) ---
  [6, 16, 23].forEach((day) => {
    addTxn(day, {
      merchant: DELIVERY[rand(0, DELIVERY.length - 1)],
      category: 'food delivery',
      amount: -(22 + rand(0, 28)),
      method: 'paypal',
      recurring: false,
    });
  });

  // --- Transport (3-4 times) ---
  [5, 12, 19].forEach((day) => {
    const isRide = Math.random() > 0.4;
    addTxn(day, {
      merchant: isRide ? RIDESHARE[rand(0, 1)] : GAS[rand(0, 2)],
      category: 'transport',
      amount: -(isRide ? rand(10, 35) : rand(45, 80)),
      method: isRide ? 'paypal' : 'card',
      recurring: false,
    });
  });
  if (Math.random() > 0.4) {
    addTxn(27, {
      merchant: RIDESHARE[rand(0, 1)],
      category: 'transport',
      amount: -(rand(10, 30)),
      method: 'paypal',
      recurring: false,
    });
  }

  // --- Shopping (1-2 times) ---
  addTxn(14, {
    merchant: SHOPPING[rand(0, SHOPPING.length - 1)],
    category: 'shopping',
    amount: -(30 + rand(0, 130)),
    method: Math.random() > 0.5 ? 'card' : 'paypal',
    recurring: false,
  });
  if (Math.random() > 0.4) {
    addTxn(22, {
      merchant: SHOPPING[rand(0, SHOPPING.length - 1)],
      category: 'shopping',
      amount: -(30 + rand(0, 90)),
      method: Math.random() > 0.5 ? 'card' : 'paypal',
      recurring: false,
    });
  }

  // --- Health (occasional) ---
  if (Math.random() > 0.35) {
    addTxn(rand(15, 25), {
      merchant: HEALTH[rand(0, HEALTH.length - 1)],
      category: 'health',
      amount: -(15 + rand(0, 70)),
      method: 'card',
      recurring: false,
    });
  }

  // --- Entertainment (occasional) ---
  if (Math.random() > 0.5) {
    addTxn(rand(8, 28), {
      merchant: ['Starlight Cinemas', 'PixelPlay', 'GameVault Store', 'FlixNow'][rand(0, 3)],
      category: 'entertainment',
      amount: -(rand(10, 55)),
      method: 'card',
      recurring: false,
    });
  }

  return txns;
}

export function generateSeedData(): Transaction[] {
  const today = new Date();
  const transactions: Transaction[] = [];

  // Generate 12 months of history
  for (let m = 11; m >= 0; m--) {
    const d = new Date(today.getFullYear(), today.getMonth() - m, 1);
    transactions.push(...generateMonthTransactions(d.getFullYear(), d.getMonth() + 1, today));
  }

  // Sort by date
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  return transactions;
}

export const seedTransactions = generateSeedData();
