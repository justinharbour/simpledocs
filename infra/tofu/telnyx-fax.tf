terraform {
  required_providers {
    telnyx = {
      source  = "registry.terraform.io/petsinc/telnyx"
      version = "= 2.4.0"
    }
  }
}

# Deliberately opt-in: neither this resource nor the provider manages a fax
# application or changes an existing telephone number's connection.
variable "create_telnyx_fax_outbound_profile" {
  type    = bool
  default = false
}

variable "telnyx_fax_billing_group_id" {
  type    = string
  default = ""
}

variable "telnyx_fax_daily_spend_limit" {
  type    = string
  default = ""
}

variable "telnyx_fax_destination_countries" {
  type    = list(string)
  default = []
}

resource "telnyx_outbound_voice_profile" "fax" {
  count = var.create_telnyx_fax_outbound_profile ? 1 : 0

  name                      = "simpledocs-fax-prod"
  billing_group_id          = var.telnyx_fax_billing_group_id
  enabled                   = false
  concurrent_call_limit     = 1
  daily_spend_limit         = var.telnyx_fax_daily_spend_limit
  daily_spend_limit_enabled = true
  whitelisted_destinations  = var.telnyx_fax_destination_countries

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(trimspace(var.telnyx_fax_billing_group_id)) > 0 && can(regex("^[0-9]+(\\.[0-9]{1,2})?$", var.telnyx_fax_daily_spend_limit)) && try(tonumber(var.telnyx_fax_daily_spend_limit) > 0, false) && length(var.telnyx_fax_destination_countries) > 0 && alltrue([for country in var.telnyx_fax_destination_countries : can(regex("^[A-Z]{2}$", country))])
      error_message = "A billing group, positive daily spend limit, and explicit two-letter destination country allowlist are required."
    }
  }
}

output "telnyx_fax_outbound_profile_id" {
  value = try(telnyx_outbound_voice_profile.fax[0].id, null)
}
