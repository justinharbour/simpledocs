variable "encryption_key" {
  type      = string
  sensitive = true
}

variable "r2_endpoint" {
  type = string
}

terraform {
  required_version = ">= 1.13.0, < 2.0.0"

  backend "s3" {
    bucket                      = "tfstate-r2-shared"
    key                         = "simpledocs/prod/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = var.r2_endpoint }
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }

  encryption {
    key_provider "pbkdf2" "simpledocs" {
      passphrase = var.encryption_key
    }
    method "aes_gcm" "simpledocs" {
      keys = key_provider.pbkdf2.simpledocs
    }
    state {
      method   = method.aes_gcm.simpledocs
      enforced = true
    }
    plan {
      method   = method.aes_gcm.simpledocs
      enforced = true
    }
  }
}
