# Contracts

A contract is a bilateral agreement the engine records and holds. It has a proposer and a counterparty, a list of obligations, and free text terms the engine stores but never reads.

Each obligation names who owes (`proposer` or `counterparty`), what (goods of one kind and quantity, or a cash amount), and a due turn.

## Lifecycle

- `proposed`: the counterparty can `accept_contract` or `reject_contract`, the proposer can `withdraw_contract`. A proposal left open past the end of the next turn expires.
- `active`: once accepted. Each party puts in what it owes with `deliver` (goods) or `pay` (cash), naming the contract and the obligation index. Deposits leave you at once and are held by the engine. Partial deposits are allowed.
- `completed`: every obligation is in. Each deposit goes to its receiver.
- `defaulted`: at the end of a turn, an obligation due that turn was still not fully in. The contract settles then and is over.

## Settlement of a default

A party that put in everything it owed gets its deposits back at no cost. A party that did not loses everything it put in and is charged a penalty: a share of the value of its side of the contract, 75% when enforcement is on and half that when off. The penalty is cash, taken even if that leaves you below zero, so do not promise what you cannot put in by the due turn.

Contract ids are assigned when the round resolves. Your next observation lists them under `proposed_by_you`.

## Reputation

When visible, the ledger shows per company how many contracts completed, how many it defaulted on, and the value still owed at those defaults. It is counts and values only. What they mean is up to you.
