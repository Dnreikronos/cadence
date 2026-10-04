# Cadence — companies pay their team and suppliers in dollars without showing the amounts to the world

Status: draft
Date: 2026-09-27 · Owner: João · Currency: USDC only
Supersedes: [PRD — payroll rail for Brazil](prd-confidential-payroll-rail.md)
Architecture decisions: [ADR 2026-09-27](decisions/2026-09-27-confidential-payroll-rail-architecture.md)

## In thirty seconds

Crypto companies pay their team, freelancers and suppliers in USDC. Every one of those payments is public: anyone can see what each person earns, who the suppliers are, and how much the company has left.

Cadence is a web dashboard where the same payments happen with the amount hidden. The recipient sees it. The accountant sees it. Everyone else sees only that a payment occurred.

Sold by monthly subscription. First customers are crypto startups and projects on Solana already paying people in USDC. Later, an API so payment platforms can offer it inside their own products.

## The problem

Solaris (fictional) is a twenty-person startup on Solana. Every month it pays salaries, freelancers and suppliers in USDC straight from the company wallet, and all of it is public.

| Who looks    | What they see                     | What they do with it                |
| ------------ | --------------------------------- | ----------------------------------- |
| An employee  | Every colleague's salary          | Resentment, a raise demand, an exit |
| A competitor | What Solaris pays each dev        | Offers 20% more and takes the team  |
| A supplier   | What Solaris pays other suppliers | Raises their price                  |
| A freelancer | How much runway the company has   | Quotes higher                       |
| An attacker  | Which wallet holds a lot          | Picks Solaris as a target           |
| The market   | That the treasury is running down | Loses confidence                    |

What companies do about it today: rotate wallets constantly, which is laborious and wrecks the bookkeeping; pay by bank instead, which is slow and expensive across borders; use mixing tools, which looks like laundering; or accept it and hope nobody looks.

TODO(João): the supporting evidence in the source deck — a freelancer repriced after a client inspected their wallet, founders describing USDC payment as "handing over your bank statement," a single-victim loss figure, and B2B stablecoin volume — is unverified. Check each before any of it reaches a judge or a customer.

### Why nobody solved it before

Solana's amount-hiding feature was switched off between June 2025 and June 2026 after a bug in the ZK ElGamal Proof program. It came back at epoch 982 in June 2026, with Token-2022 redeployed carrying the confidential instructions on 2026-06-17. Then on **2026-09-15**, transaction v1 raised the transaction size cap from 1,232 to 4,096 bytes at mainnet epoch 1035 — and a hidden payment finally fit in a single transaction. The reference implementation is 2,897 bytes. The piece has been ready for twelve days, and adoption is close to zero.

## What we're building

| #   | Product                                                                            | For whom                                  | When                |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------- | ------------------- |
| 1   | **Cadence App** — dashboard for paying people and suppliers with the amount hidden | Crypto startups, projects, DAOs           | This hackathon      |
| 2   | **Auditor panel** — the accountant sees every amount and exports a report          | The customer's accountant or finance lead | This hackathon      |
| 3   | **Cadence API** — the same engine, embedded in someone else's product              | B2B payment platforms                     | After the hackathon |

The dashboard comes first because it sells in one conversation and gets used the same day. The API is worth more money and takes months to sell.

### Who sees what

| Person                            | Sees a payment happened? | Sees the amount?                                                                   |
| --------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| The paying company                | Yes                      | Yes                                                                                |
| The recipient                     | Yes                      | Yes                                                                                |
| An auditor the company designates | Yes                      | Yes                                                                                |
| **Cadence**                       | Yes                      | **Yes** — proof generation is server-side, so the service holds viewing capability |
| Anyone else                       | Yes                      | No                                                                                 |

Two things have to be stated in the product in plain words.

We hide the amount and the balance, not who paid whom — wallet addresses stay public. It is confidentiality, not anonymity.

And Cadence can technically read amounts, because the service generates the proofs. It never holds funds or signing keys, so it cannot move anyone's money, but it is not a zero-knowledge operator. The honest comparison is a bank or a payment processor: the processor and the accountant can see, the neighbour cannot. Claiming otherwise would be false, and a judge or a security-minded customer will ask.

## How the dollar stays hidden

Normal USDC cannot hide amounts. The feature has to be enabled when a token is created, and USDC was created without it, with no migration path. So Cadence uses **private USDC**: a 1:1 wrapped version, where every private dollar is backed by a normal one held in a public on-chain contract anyone can verify.

| Step | Who     | What happens                                              | Is the amount public?                    |
| ---- | ------- | --------------------------------------------------------- | ---------------------------------------- |
| 1    | Company | Deposits $84,000 in normal USDC, receives $84,000 private | Yes — the total deposit is visible       |
| 2    | Company | Pays 20 people in private USDC                            | No — 20 payments appear, without amounts |
| 3    | Bruno   | Sees "you received $4,200" in Cadence                     | No — only Bruno sees it                  |
| 4    | Bruno   | Holds private USDC as long as he likes                    | No — his balance stays hidden            |
| 5    | Bruno   | Withdraws, turning private USDC back into normal USDC     | Yes — withdrawals are public             |

**Privacy lasts as long as the money stays wrapped.** If Bruno withdraws exactly $4,200 on payday, an attentive observer infers his salary. If he withdraws in pieces when he needs them, nothing links the withdrawals to the payment. That is why funds stay private by default and why the dashboard warns before an exact-amount withdrawal.

Even if Bruno withdraws everything immediately, the company side stays protected: nobody learns what it pays each person or what it holds. And the company is who pays for the product.

Cadence never holds anyone's money and never holds a signing key — the USDC sits in the on-chain contract and every user signs with their own wallet. It does hold the viewing keys needed to generate proofs, so it can read amounts but can never move funds.

## Not building

- **Other currencies.** Dollars only in v1.
- **Conversion to local currency.** Recipients withdraw to normal USDC and convert wherever they already convert. Currency conversion is a regulated activity — see the ADR for what that would cost.
- **Custody of funds or keys.** Never.
- **Anonymity.** Amounts and balances only.
- **A mobile app.** The web dashboard works on a phone.
- **Our own wallet.** An embedded-wallet provider covers users who don't have one.
- **Brazilian payroll with FGTS, INSS and eSocial.** Different product, different customer.

## How people use it

**Ana, COO of Solaris, runs payroll.** First time, about ten minutes: she signs in with the company wallet, adds twenty people with name, email and monthly amount. Each person gets an invite by email. Every month after that, about two minutes: she opens a new run, sees the list and the $84,000 total, deposits, reviews and approves. If the company uses a multisig, the other partners approve too. The payments land in seconds and she can download every receipt. A competitor watching the chain sees twenty payments from Solaris and no amounts.

**Bruno, a developer, gets paid.** He clicks the invite and signs in with email or the wallet he already uses; if he has neither, one is created behind the scenes without him learning what a seed phrase is. When the payment lands he gets an email with the amount, the date and who sent it. His dashboard shows his real balance and every past payment. When he wants the money he withdraws — and if he tries to withdraw exactly what he was paid, the dashboard warns him first.

Bruno always sees his amount. The only question is where: in Cadence and in the email from day one, and in Phantom only after he withdraws, because wallets cannot yet display a hidden balance. Getting wallets to show it is part of the business.

**Paying a supplier** is the same flow with one recipient. The other suppliers never learn what the code auditor charges, and the code auditor never learns what the treasury holds.

**Carla, the accountant, closes the month.** Ana adds her as an auditor. Carla sees every payment with amounts, dates and recipients, and exports a spreadsheet. If a regulator or an investor asks, she can show them. Confidentiality is not hiding from the law; it is choosing who sees.

## Pricing

To be validated in the conversations, not assumed.

| Plan    | For whom              | Price                              | Includes                                  |
| ------- | --------------------- | ---------------------------------- | ----------------------------------------- |
| Free    | Trying it             | $0                                 | Up to 3 people per month                  |
| Team    | Small startups        | $199/mo                            | Up to 25 people, receipts                 |
| Company | Larger teams and DAOs | $799/mo                            | Unlimited people, multisig, auditor panel |
| API     | Platforms             | From $2,000/mo + $0.05 per payment | Embedded in their product                 |

The fee is for software. It is never a spread on the amount transferred and Cadence never holds balances to earn on them — both would change what kind of business this is.

## Requirements

| #   | Requirement                                                                         | Done when                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | A company pays many people from one approval                                        | A real mainnet run of ≥3 people goes out on one approval and all three confirm receipt                                                                                                                                                       |
| R2  | The amount is hidden from the world                                                 | A block explorer and a third-party RPC both show ciphertext; the dashboard shows the real amount to the recipient                                                                                                                            |
| R3  | Each payment is a single transaction                                                | The payment resolves to one confirmed transaction under 4,096 bytes, not a chain                                                                                                                                                             |
| R4  | The auditor sees amounts, and only the auditor                                      | A designated auditor reads a test payment's amount; another party with identical chain access cannot                                                                                                                                         |
| R5  | A recipient onboards knowing nothing about crypto                                   | Someone who has never used crypto signs in and finds their balance unaided, observed rather than self-reported                                                                                                                               |
| R6  | A recipient can withdraw                                                            | At least one person converts private USDC to normal USDC and moves it to an exchange                                                                                                                                                         |
| R6b | The dashboard warns before a withdrawal that reveals a salary                       | Attempting to withdraw exactly the amount of a received payment shows the warning before confirmation                                                                                                                                        |
| R7  | Both sides get records                                                              | Company and recipient each export history with amounts and dates                                                                                                                                                                             |
| R8  | No plaintext amount is stored off-chain                                             | A dump of every database table contains no readable payment amount                                                                                                                                                                           |
| R9  | Payments survive the feature being switched off                                     | With the proof program simulated unavailable, a run completes as ordinary transfers                                                                                                                                                          |
| R10 | No tenant can read another tenant's data                                            | A session attempting to read another company's roster or another person's payments fails; covered by tests that run on every migration                                                                                                       |
| R11 | Cadence cannot move customer funds, and every decryption it performs is accountable | No signing key reaches our infrastructure, demonstrable from network traffic. ElGamal secrets are encrypted at rest using Supabase Vault (ADR B19), decryption is access-controlled, and an audit log records actor and reason for every one |
| R12 | Real companies are using it                                                         | At least 2 real companies have made a real payment through Cadence before submission                                                                                                                                                         |

## Constraints

- **Normal USDC cannot hide amounts.** The extension must exist at mint creation and there is no migration path, which is why private USDC exists. Source: [Confidential Balances docs](https://solana.com/docs/tokens/extensions/confidential-transfer).
- **Entry and exit are public.** The company's deposit and each recipient's withdrawal show amounts; only what happens in between is hidden.
- **Wallets do not yet display hidden balances.** Non-supporting wallets degrade gracefully — they show the public balance and ordinary transfers keep working — but the recipient reads their real balance in our dashboard. Source: [integration guide](https://solana.com/docs/tokens/extensions/confidential-transfer/integration-guide).
- **Balance display must use the AES `decryptable_available_balance`.** Decrypting the ElGamal balance directly is a discrete-log solve and is too slow for UI.
- **Hidden payments cost more compute than ordinary ones** — range proofs run 111k CU (64-bit) to 368k CU (256-bit) against a 1.4M ceiling. Irrelevant at payroll volume. Source: [proof cost breakdown](https://xroot.dev/blog/solana-confidential-transfers-kill-switch-proof-cost).
- **Amounts are capped at 48 bits**, about $281M per payment for a 6-decimal token. Affects no customer.
- **Row-level security is the only authorization tier.** The client reads Postgres directly, so a missing policy is a breach rather than a code smell. See R10.
- **The ZK program has a kill switch.** `disable_zk_elgamal_proof_program` and `reenable_zk_elgamal_proof_program` remain ordinary feature gates activated at epoch boundaries after 95% stake adoption. See R9.
- **Development needs devnet or a mainnet-forking validator.** A stock `solana-test-validator` does not enable the ZK ElGamal Proof program.
- **RPC clients must declare `maxSupportedTransactionVersion: 1`**, or `getBlock` fails for any block containing a v1 transaction.
- **Submission closes 2026-10-12, 23:59 PT.** One submission per team, with mandatory disclosure of pre-existing development.

## Competitors

| Who              | What they do                                     | Where we win                                                               |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| Arcium + Umbra   | Privacy via an extra network and their own token | Native Solana feature, built for companies paying people, auditor included |
| Payy             | Their own chain on top of Ethereum               | The customer never leaves Solana                                           |
| Circle Arc       | Circle's chain with privacy, not yet live        | We are live now                                                            |
| Rise, Toku, Deel | Crypto payroll without hidden amounts            | Not competitors — they are API customers                                   |
| Rotating wallets | What companies do today                          | One click, without wrecking the books                                      |

TODO(João): the deposit figure cited for Umbra and Circle Arc's launch status both need checking.

## Risks

| Risk                                                                | Likelihood  | What we do                                                                                                                                                                             |
| ------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Our proof service is breached, exposing every customer's amounts    | Low, severe | R11 — Supabase Vault encryption at rest, access control, decryption audit log. The concentration is inherent to server-side proof generation and is the accepted cost of that decision |
| A customer or judge expects "you cannot see it" and we say "we can" | High        | Say it first, in the product and the pitch, rather than being caught by the question                                                                                                   |
| Companies find it interesting but won't pay                         | Medium      | Validate with pilots before building more — see below                                                                                                                                  |
| Wallets take years to show hidden balances                          | High        | Our dashboard covers it; approach Phantom early                                                                                                                                        |
| Circle, Arcium or Solana ship the same thing                        | Medium      | Arrive first, be the easiest, own the auditor panel                                                                                                                                    |
| Solana switches the feature off again                               | Low         | R9 — payments continue as ordinary transfers                                                                                                                                           |
| Someone associates the product with laundering                      | Medium      | Auditor from day one; say explicitly it is not anonymity                                                                                                                               |
| Multisig cannot originate a hidden payment                          | Unknown     | Q4 — a paid tier depends on this and nobody has checked                                                                                                                                |

## Validation

**The question:** would crypto startups on Solana pay to hide the amounts of payments they already make in USDC?

Run the sales process until **ten conversations** are done. Not for a fixed number of days — until ten. Ask about what already happened, never about what someone would hypothetically do:

1. How do you pay the team and suppliers today?
2. Has anyone ever seen or commented on an amount they found on-chain? What happened?
3. Do you do anything to hide it? How much work is that?
4. If nobody else could see the amounts, what would change for you?
5. Would you run your next payroll through Cadence, free?

**Decide when the tenth conversation ends:**

| After 10 conversations                           | Decision                             |
| ------------------------------------------------ | ------------------------------------ |
| ≥3 tell a real story **and** ≥2 agree to a pilot | Full speed                           |
| Everyone says "interesting", nobody has a story  | Change the customer and run it again |
| Nobody cares                                     | Stop and go back to the idea list    |

Everything goes in one sheet: company, person, date, real story yes/no, pilot yes/no, strongest quote. The real quotes go into the pitch.

## Open questions

Resolved 2026-09-27: **proof generation runs in the browser** — WASM cost is judged acceptable, which is what makes R11 claimable. That decision also collapses the old auditor-key question, because with client-side proofs an auditor key becomes the only remaining path to visibility.

| #   | Question                                                                                                                                                                                                                                  | Owner              | Needed by                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------- |
| Q2  | Auditor access via an app-level grant on a shared mint, or a mint per company with its own auditor key? The second is better and needs a deeper `token-wrap` fork; moving from the first to the second is a migration, not a key rotation | João               | Before the wrapped mint is created |
| Q3  | Which embedded-wallet provider works with hidden payments? Turnkey's Solana policy engine parses instructions and may not handle confidential-transfer ones                                                                               | João               | Before the provider is locked      |
| Q4  | Can a Squads multisig originate a hidden payment? Proof generation needs the sender's ElGamal secret, and a multisig vault is a PDA with no private key. The Company tier sells multisig                                                  | João               | Before the Company tier is sold    |
| Q5  | Is the pricing right?                                                                                                                                                                                                                     | Team               | After the ten conversations        |
| Q6  | Verify every number in this document and the source deck                                                                                                                                                                                  | TODO(João): assign | Before anything external           |
