use cadence_proof::config::Config;
use std::collections::HashMap;

fn environment() -> HashMap<&'static str, String> {
    HashMap::from([
        ("PROOF_RPC_URL", "https://api.devnet.solana.com".into()),
        ("BUILD_SHA", "a".repeat(40)),
    ])
}

#[test]
fn required_settings_and_defaults() {
    let env = environment();
    let config = Config::parse(|key| env.get(key).cloned()).unwrap();
    assert_eq!(config.bind_addr.to_string(), "0.0.0.0:3000");
    assert_eq!(config.rpc_timeout.as_millis(), 5000);
    for key in ["PROOF_RPC_URL", "BUILD_SHA"] {
        let mut env = environment();
        env.remove(key);
        assert!(Config::parse(|key| env.get(key).cloned()).is_err());
    }
}

#[test]
fn invalid_settings_fail_without_echoing_values() {
    for (key, value) in [
        ("PROOF_RPC_URL", ""),
        ("PROOF_RPC_URL", "secret-provider-token"),
        ("PROOF_RPC_URL", "file:///secret-provider-token"),
        ("BUILD_SHA", ""),
        ("BUILD_SHA", "abc123"),
        ("BUILD_SHA", "gggggggggggggggggggggggggggggggggggggggg"),
        ("PROOF_BIND_ADDR", "localhost"),
        ("PROOF_RPC_TIMEOUT_MS", "0"),
        ("PROOF_RPC_TIMEOUT_MS", "60001"),
        ("PROOF_RPC_TIMEOUT_MS", "-1"),
    ] {
        let mut env = environment();
        env.insert(key, value.into());
        let error = Config::parse(|key| env.get(key).cloned())
            .err()
            .expect("invalid config");
        assert!(!error.to_string().contains("secret-provider-token"));
    }
}
