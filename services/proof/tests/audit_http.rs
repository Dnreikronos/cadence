#[path = "support/confidential.rs"]
#[allow(dead_code)]
mod fixture;

use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::solana::{confidential, reveal_risk, v1};

#[test]
fn sender_ciphertext_requires_the_correct_account_mint_and_viewing_key() {
    let f = fixture::Fixture::new();
    let transfer = f.transfer();
    let tx =
        STANDARD.encode(v1::serialize(&confidential::build(&transfer, &f.key).unwrap()).unwrap());
    assert_eq!(
        *reveal_risk::sent_amount(&tx, &transfer.sender, &transfer.mint, &f.key).unwrap(),
        fixture::AMOUNT
    );
    assert!(reveal_risk::sent_amount(&tx, &transfer.recipient, &transfer.mint, &f.key).is_err());
    assert!(reveal_risk::sent_amount(&tx, &transfer.sender, &transfer.sender, &f.key).is_err());
    let other = fixture::Fixture::new();
    assert!(reveal_risk::sent_amount(&tx, &transfer.sender, &transfer.mint, &other.key).is_err());
}
