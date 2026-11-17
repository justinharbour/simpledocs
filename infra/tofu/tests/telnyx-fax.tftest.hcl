mock_provider "telnyx" {}

variables {
  encryption_key = "disposable-test-key-not-for-production"
  r2_endpoint    = "https://example.invalid"
}

run "default_does_not_create_profile" {
  command = plan

  assert {
    condition     = length(telnyx_outbound_voice_profile.fax) == 0
    error_message = "The fax profile must be opt-in."
  }
}

run "dedicated_profile_is_disabled_and_limited" {
  command = plan

  variables {
    create_telnyx_fax_outbound_profile = true
    telnyx_fax_billing_group_id       = "test-billing-group"
    telnyx_fax_daily_spend_limit      = "5.00"
    telnyx_fax_destination_countries  = ["US"]
  }

  assert {
    condition     = length(telnyx_outbound_voice_profile.fax) == 1 && !telnyx_outbound_voice_profile.fax[0].enabled && telnyx_outbound_voice_profile.fax[0].daily_spend_limit_enabled && telnyx_outbound_voice_profile.fax[0].concurrent_call_limit == 1
    error_message = "The profile must remain disabled and limited."
  }
}

run "profile_requires_explicit_limits" {
  command = plan

  variables {
    create_telnyx_fax_outbound_profile = true
  }

  expect_failures = [telnyx_outbound_voice_profile.fax]
}
