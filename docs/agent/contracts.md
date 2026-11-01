# Contracts

A contract is a bilateral agreement the engine records. It has a proposer and a counterparty, a list of obligations, an escrow flag, and free text terms the engine stores but never reads.

Each obligation names who owes (`proposer` or `counterparty`), what (goods of one kind and quantity, or a cash amount), and a due turn. Obligations can have different due turns, so a contract can be a sale, a loan with repayment later, or a schedule.

## Lifecycle

- `proposed`: the counterparty can `accept_contract` or `reject_contract`, the proposer can `withdraw_contract`. A proposal left open past the end of the next turn expires.
- `active`: once accepted. The obligated party fulfils with `deliver` (goods) or `pay` (cash), naming the contract and the obligation index. Partial fulfilment is allowed.
- `completed`: every obligation met on time.
- `defaulted`: an obligation was still unmet at the end of its due turn. The default names who failed and the reference value still owed.
- `cured`: a defaulted contract whose obligations were all met later.

Contract ids are assigned when the round resolves. Your next observation lists them under `proposed_by_you`.

## Escrow

When a proposal has `escrow: true` and the run allows escrow, both sides pay half of a fee of 5% of the contract's value when it is accepted. Deliveries and payments on the contract go into escrow instead of to the other party. Once everything is deposited, escrow releases both sides at once. If the latest due turn ends first, deposits are refunded and the default is recorded against whoever had not deposited.

## Reputation

When visible, the ledger shows per company how many contracts completed, how many are in default and for what value, and how many defaults were later cured and for what value. It is counts and values only. What they mean is up to you.
