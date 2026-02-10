data_dir = "/opt/nomad/data"

server {
  enabled          = true
  bootstrap_expect = 1
}

client {
  enabled = true

  host_volume "cdn" {
    path      = "/home/hamza/apps/cypher/cdn"
    read_only = false
  }
}

plugin "docker" {
  config {
    allow_privileged = false
    volumes {
      enabled = true
    }
  }
}
