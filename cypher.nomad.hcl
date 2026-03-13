variable "traefik_auth" {
  type        = string
  description = "Traefik basic auth credentials"
}

variable "database_url" {
  type        = string
  description = "PostgreSQL connection string"
}

variable "redis_url" {
  type        = string
  description = "Redis connection string"
}

variable "image_tag" {
  type        = string
  description = "Docker image tag for this deployment"
}

variable "jwt_secret" {
  type        = string
  description = "JWT signing secret"
}

variable "internal_api_key" {
  type        = string
  description = "Internal API key for service-to-service auth"
}

variable "app_url" {
  type        = string
  description = "Public application URL"
  default     = "https://cypher.md"
}

variable "cors_origin" {
  type        = string
  description = "CORS allowed origin"
  default     = "https://cypher.md"
}

variable "mail_server_name" {
  type        = string
  description = "SMTP server hostname"
}

variable "mail_port" {
  type        = string
  description = "SMTP server port"
  default     = "587"
}

variable "mail_username" {
  type        = string
  description = "SMTP username"
}

variable "mail_password" {
  type        = string
  description = "SMTP password"
}

variable "mail_from" {
  type        = string
  description = "Email sender address"
  default     = "noreply@cypher.md"
}

variable "mail_from_name" {
  type        = string
  description = "Email sender display name"
  default     = "Cypher"
}

job "cypher" {
  datacenters = ["dc1"]
  type        = "service"

  # =============================================================================
  # Traefik - Reverse Proxy
  # =============================================================================
  group "traefik" {
    count = 1

    network {
      mode = "host"
    }

    task "traefik" {
      driver = "docker"

      config {
        image        = "traefik:v3.6"
        force_pull   = false
        network_mode = "host"

        args = [
          "--providers.docker=true",
          "--providers.docker.exposedbydefault=false",
          "--providers.docker.network=hamza",
          "--entrypoints.web.address=:4000",
          "--ping=true",
          "--log.level=WARN",
        ]

        volumes = [
          "/var/run/docker.sock:/var/run/docker.sock:ro",
        ]
      }

      resources {
        cpu    = 200
        memory = 128
      }
    }
  }

  # =============================================================================
  # Web - Static files + SPA
  # =============================================================================
  group "web" {
    count = 1

    update {
      max_parallel     = 1
      min_healthy_time = "10s"
      healthy_deadline = "3m"
      auto_revert      = true
    }

    task "web" {
      driver = "docker"

      config {
        image        = "cypher-web:${var.image_tag}"
        force_pull   = false
        network_mode = "hamza"

        labels = {
          "traefik.enable"                                     = "true"
          # Public router for PWA files (no auth)
          "traefik.http.routers.web-public.rule"               = "Path(`/manifest.json`) || Path(`/favicon.png`) || Path(`/icon-192.png`) || Path(`/icon-512.png`)"
          "traefik.http.routers.web-public.entrypoints"        = "web"
          "traefik.http.routers.web-public.priority"           = "100"
          "traefik.http.routers.web-public.service"            = "web"
          # Main router with auth
          "traefik.http.routers.web.rule"                      = "PathPrefix(`/`)"
          "traefik.http.routers.web.entrypoints"               = "web"
          "traefik.http.routers.web.priority"                  = "1"
          "traefik.http.routers.web.middlewares"               = "auth"
          "traefik.http.middlewares.auth.basicauth.users"      = var.traefik_auth
          "traefik.http.middlewares.auth.basicauth.realm"      = "Cypher"
          "traefik.http.services.web.loadbalancer.server.port" = "4000"
        }
      }

      env {
        NODE_ENV = "production"
        PORT     = "4000"
      }

      resources {
        cpu    = 200
        memory = 256
      }
    }
  }

  # =============================================================================
  # API - Backend server
  # =============================================================================
  group "api" {
    count = 1

    update {
      max_parallel     = 1
      min_healthy_time = "10s"
      healthy_deadline = "3m"
      auto_revert      = true
    }

    volume "cdn" {
      type      = "host"
      source    = "cdn"
      read_only = false
    }

    task "api" {
      driver = "docker"

      config {
        image        = "cypher-api:${var.image_tag}"
        force_pull   = false
        network_mode = "hamza"
        hostname     = "cypher-api"

        labels = {
          "traefik.enable"                                     = "true"
          "traefik.http.routers.api.rule"                      = "PathPrefix(`/api`)"
          "traefik.http.routers.api.entrypoints"               = "web"
          "traefik.http.routers.api.priority"                  = "10"
          "traefik.http.routers.api.middlewares"               = "auth"
          "traefik.http.services.api.loadbalancer.server.port" = "3000"
        }
      }

      volume_mount {
        volume      = "cdn"
        destination = "/app/cdn"
      }

      env {
        NODE_ENV         = "production"
        PORT             = "3000"
        DATABASE_URL     = var.database_url
        REDIS_URL        = var.redis_url
        JWT_SECRET       = var.jwt_secret
        INTERNAL_API_KEY = var.internal_api_key
        APP_URL          = var.app_url
        CORS_ORIGIN      = var.cors_origin
        MAIL_SERVER_NAME = var.mail_server_name
        MAIL_PORT        = var.mail_port
        MAIL_USERNAME    = var.mail_username
        MAIL_PASSWORD    = var.mail_password
        MAIL_FROM        = var.mail_from
        MAIL_FROM_NAME   = var.mail_from_name
      }

      resources {
        cpu    = 300
        memory = 512
      }
    }
  }

  # =============================================================================
  # Live - WebSocket server
  # =============================================================================
  group "live" {
    count = 2

    update {
      max_parallel     = 1
      min_healthy_time = "10s"
      healthy_deadline = "3m"
      auto_revert      = true
    }

    task "live" {
      driver = "docker"

      config {
        image        = "cypher-live:${var.image_tag}"
        force_pull   = false
        network_mode = "hamza"

        labels = {
          "traefik.enable"                                      = "true"
          "traefik.http.routers.live.rule"                      = "PathPrefix(`/ws`)"
          "traefik.http.routers.live.entrypoints"               = "web"
          "traefik.http.routers.live.priority"                  = "10"
          "traefik.http.services.live.loadbalancer.server.port" = "8080"
        }
      }

      env {
        NODE_ENV         = "production"
        PORT             = "8080"
        REDIS_URL        = var.redis_url
        JWT_SECRET       = var.jwt_secret
        API_BASE_URL     = "http://cypher-api:3000"
        INTERNAL_API_KEY = var.internal_api_key
      }

      resources {
        cpu    = 200
        memory = 256
      }
    }
  }
}
