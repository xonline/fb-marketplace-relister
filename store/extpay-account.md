# ExtPay (ExtensionPay) Account — Relist for Facebook Marketplace

Set up 2026-06-26.

## Account
- Login email: **poy@x-online.com.au**
- Dashboard: https://extensionpay.com/home
- Password: set by Poy during signup (in his password manager — not stored here)

## Registered extension
- **Slug (use in code):** `relist-for-facebook-marketplace`
  - Code: `const extpay = ExtPay('relist-for-facebook-marketplace')`
- Edit/plans: https://extensionpay.com/home/extension/relist-for-facebook-marketplace/edit

## Payment plans (live)
| Plan | Price | Interval | Stripe price ID | ExtPay nickname |
|------|-------|----------|-----------------|-----------------|
| Monthly | USD 4.99 | month | `price_1TmUoFIWmaP6pqyOKtQ3p3FC` | monthly |
| Yearly | USD 39 | year | `price_1TmUpYIWmaP6pqyOMXdcD3Tm` | yearly |

> In code, reference a plan via its nickname (`monthly` / `yearly`) per ExtPay v3 docs, or omit to let the user choose at checkout.

## Stripe Connect
- Connected account id: `acct_1TmUiCIWmaP6pqyO` (created via ExtPay → Stripe Connect onboarding)
- **Status: Poy completing onboarding** (business-owner details on connect.stripe.com). Required before collecting LIVE payments.
- After connect: enable the **live Stripe customer portal** in ExtPay settings.

## ExtPay version
- v3.1 (multi-plan, Stripe Checkout, coupon codes supported).

## Remaining
- [ ] Poy: finish Stripe Connect onboarding
- [ ] Enable live Stripe customer portal
- [ ] Swap/confirm slug in extension code (gating build v3.7.2) — slug already matches `relist-for-facebook-marketplace`
- [ ] Test payment flow in ExtPay test mode before going live
