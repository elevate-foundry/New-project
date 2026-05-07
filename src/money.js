import { assert } from './errors.js';
import { id } from './ids.js';

function amountToBigInt(value) {
  assert(value !== undefined && value !== null, 400, 'invalid_amount', 'Amount is required.');
  const amount = BigInt(value);
  assert(amount > 0n, 400, 'invalid_amount', 'Amount must be greater than zero.');
  return amount;
}

export class MoneyService {
  constructor({ now = () => new Date(), emit = () => {} } = {}) {
    this.now = now;
    this.emit = emit;
    this.accounts = new Map();
    this.transactions = new Map();
    this.idempotencyKeys = new Map();
    this.settlementAccounts = new Map();
  }

  createAccount({ ownerId, currency }) {
    assert(ownerId, 400, 'missing_owner', 'Owner id is required.');
    assert(/^[A-Z]{3}$/.test(String(currency ?? '')), 400, 'invalid_currency', 'Currency must be a three-letter ISO code.');
    const account = {
      id: id('acct'),
      ownerId,
      currency,
      balance: 0n,
      createdAt: this.now().toISOString()
    };
    this.accounts.set(account.id, account);
    return this.serializeAccount(account);
  }

  credit({ accountId, amount, idempotencyKey, description = 'credit' }) {
    const account = this.requireAccount(accountId);
    const settlement = this.requireSettlementAccount(account.currency);
    return this.record({
      idempotencyKey,
      description,
      entries: [
        { accountId: settlement.id, direction: 'debit', amount },
        { accountId: account.id, direction: 'credit', amount }
      ]
    });
  }

  transfer({ fromAccountId, toAccountId, amount, idempotencyKey, description = 'transfer' }) {
    const from = this.requireAccount(fromAccountId);
    const to = this.requireAccount(toAccountId);
    assert(from.currency === to.currency, 400, 'currency_mismatch', 'Accounts must use the same currency.');
    return this.record({
      idempotencyKey,
      description,
      entries: [
        { accountId: from.id, direction: 'debit', amount },
        { accountId: to.id, direction: 'credit', amount }
      ]
    });
  }

  record({ entries, idempotencyKey, description }) {
    assert(idempotencyKey, 400, 'missing_idempotency_key', 'Idempotency key is required.');
    if (this.idempotencyKeys.has(idempotencyKey)) {
      return this.serializeTransaction(this.transactions.get(this.idempotencyKeys.get(idempotencyKey)));
    }

    assert(Array.isArray(entries) && entries.length > 0, 400, 'missing_entries', 'At least one ledger entry is required.');
    const normalized = entries.map((entry) => {
      const account = this.requireAccount(entry.accountId);
      assert(entry.direction === 'debit' || entry.direction === 'credit', 400, 'invalid_direction', 'Entry direction must be debit or credit.');
      return {
        accountId: account.id,
        direction: entry.direction,
        amount: amountToBigInt(entry.amount),
        currency: account.currency
      };
    });

    const currencies = new Set(normalized.map((entry) => entry.currency));
    assert(currencies.size === 1, 400, 'currency_mismatch', 'All ledger entries must use the same currency.');

    const debitTotal = normalized.filter((entry) => entry.direction === 'debit').reduce((sum, entry) => sum + entry.amount, 0n);
    const creditTotal = normalized.filter((entry) => entry.direction === 'credit').reduce((sum, entry) => sum + entry.amount, 0n);
    assert(debitTotal === creditTotal, 400, 'unbalanced_transaction', 'Debits and credits must balance.');

    for (const entry of normalized) {
      if (entry.direction === 'debit') {
        const account = this.accounts.get(entry.accountId);
        assert(account.allowOverdraft || account.balance >= entry.amount, 402, 'insufficient_funds', 'Account has insufficient funds.');
      }
    }

    const transaction = {
      id: id('txn'),
      description,
      currency: [...currencies][0],
      entries: normalized,
      createdAt: this.now().toISOString()
    };

    for (const entry of normalized) {
      const account = this.accounts.get(entry.accountId);
      account.balance += entry.direction === 'credit' ? entry.amount : -entry.amount;
    }
    this.transactions.set(transaction.id, transaction);
    this.idempotencyKeys.set(idempotencyKey, transaction.id);
    const serialized = this.serializeTransaction(transaction);
    this.emit('money.transaction.created', serialized);
    return serialized;
  }

  listAccounts(ownerId) {
    return [...this.accounts.values()]
      .filter((account) => !ownerId || account.ownerId === ownerId)
      .map((account) => this.serializeAccount(account));
  }

  requireAccount(accountId) {
    const account = this.accounts.get(accountId);
    assert(account, 404, 'account_not_found', 'Account does not exist.');
    return account;
  }

  requireSettlementAccount(currency) {
    if (this.settlementAccounts.has(currency)) {
      return this.settlementAccounts.get(currency);
    }

    const account = {
      id: `settlement_${currency}`,
      ownerId: null,
      currency,
      balance: 0n,
      allowOverdraft: true,
      createdAt: this.now().toISOString()
    };
    this.accounts.set(account.id, account);
    this.settlementAccounts.set(currency, account);
    return account;
  }

  serializeAccount(account) {
    return {
      ...account,
      balance: account.balance.toString()
    };
  }

  serializeTransaction(transaction) {
    return {
      ...transaction,
      entries: transaction.entries.map((entry) => ({
        ...entry,
        amount: entry.amount.toString()
      }))
    };
  }
}
