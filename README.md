# 9Router deployment with an optional Cloudflare WARP proxy

This repository deploys [9Router](https://hub.docker.com/r/decolua/9router), Caddy, and a private Cloudflare WARP forward proxy with Docker Compose. The public application is `https://9router.web-father.ir`. Applications on the Docker network can send selected outbound requests through `warp-proxy:8080`; requests without an explicit proxy continue through their normal Docker/VPS route.

| Service | Purpose | Reachability |
| --- | --- | --- |
| `9router` | Web application on port `20128` | Docker network only, via Caddy |
| `caddy` | TLS and public HTTP routing | Host ports `80`, `443/tcp`, `443/udp` |
| `warp-proxy` | Authenticated HTTP CONNECT and SOCKS5 over WARP | Port `8080` on `9router-network` only |

The proxy image runs the official WARP client in userspace proxy mode. It needs no WARP installation on the host, `/dev/net/tun`, `NET_ADMIN`, host network mode, or host route changes. WARP registration persists in the `warp-data` Docker volume. The existing `9router-data` volume remains in place.

## Prerequisites

- A Linux VPS with an `amd64` or `arm64` CPU, outbound Internet access, and enough free memory for the extra WARP service. The setup script creates 1 GB of swap if the host has none; check actual memory use after deployment with `docker stats`.
- Root access to run `setup.sh`. It may install Docker if absent, and it writes swap and swappiness settings when creating swap.
- `bash`, `curl`, `openssl`, and standard Linux tools. Docker Compose v2 is required; `setup.sh` checks for it.
- DNS `A` records for `9router.web-father.ir` and `warp.web-father.ir` pointing to the VPS. Add `AAAA` records only if the VPS is reachable over IPv6. Allow inbound TCP `80` and `443` for Caddy and certificate issuance. UDP `443` is used for HTTP/3. Keep SSH access open.

The hostnames are currently fixed in `docker-compose.yaml`, `Caddyfile`, and `setup.sh`. Update all three if you deploy under different names. Only Caddy owns host ports `80` and `443`.

## Fresh deployment

Put the repository files in a directory on the VPS, then run:

```bash
cd /path/to/9router
sudo bash setup.sh
```

The script creates a mode `600` `.env` containing `JWT_SECRET`, `INITIAL_PASSWORD`, `WARP_PROXY_USER`, and a random `WARP_PROXY_PASSWORD`. It prints the initial 9Router password only when it creates a new `.env`. It then pulls the Compose images and starts the stack. Save the credentials securely and never commit `.env`.

The commands below assume your shell can access the Docker daemon. Prefix `docker` commands with `sudo` if that is how Docker is configured on your VPS.

Open `https://9router.web-father.ir` after Caddy has obtained a certificate. WARP can take a few minutes to register and connect on its first start; its health check has a three minute startup grace period.

## Update an existing 9Router installation

Copy the updated `docker-compose.yaml`, `setup.sh`, and `Caddyfile` into the existing deployment directory. Keep its current `.env` and Docker volumes. Then run:

```bash
cd /path/to/9router
sudo bash setup.sh
docker compose ps
```

For an existing `.env`, the script preserves its values and appends only missing WARP proxy credentials. It does not reset the current 9Router password or replace `9router-data`. It **does pull every Compose image**, so an image tagged `latest` may update during this run. Schedule the update and back up application data as you normally would before upgrading. `docker compose down` keeps named volumes; `docker compose down -v` deletes them, including WARP registration and 9Router data.

## Use the proxy from an application

From a container already on `9router-network`, send only the requests that need WARP to either:

- HTTP/HTTPS forward proxy: `http://warp-proxy:8080`
- SOCKS5 with remote DNS resolution: `socks5h://warp-proxy:8080`

Both require the `WARP_PROXY_USER` and `WARP_PROXY_PASSWORD` values from the deployment `.env`. Supply them to the application through its existing secret mechanism. An application must explicitly configure a proxy for a request; this deployment does not set proxy environment variables on 9Router. For example, inside an application container with `curl` and those variables available:

```bash
curl --proxy http://warp-proxy:8080 \
  --proxy-user "$WARP_PROXY_USER:$WARP_PROXY_PASSWORD" \
  https://www.cloudflare.com/cdn-cgi/trace
```

Use `socks5h://` when you want hostname resolution to happen through the proxy. Avoid setting `HTTP_PROXY` or `HTTPS_PROXY` for the whole application if only selected requests should use WARP.

### Attach a separate Compose project

The default network name for this repository is `9router_9router-network`. Check it on the VPS with `docker network ls --filter name=9router-network`; a custom Compose project name changes the prefix. In the other project's Compose file, retain its existing networks and add this one as an external network. For an app that currently uses only its implicit `default` network:

```yaml
services:
  app:
    networks:
      - default
      - warp_net
    environment:
      WARP_PROXY_USER: ${WARP_PROXY_USER:?set a proxy user}
      WARP_PROXY_PASSWORD: ${WARP_PROXY_PASSWORD:?set a proxy password}

networks:
  warp_net:
    external: true
    name: 9router_9router-network
```

Place the proxy credentials in the other project's protected environment or secret store. Sharing the Docker network allows the app to resolve `warp-proxy`; it does not automatically proxy the app's traffic. Keep any other networks the app already uses. Docker Compose `depends_on` does not span separate projects, so make the app handle temporary proxy unavailability or check the WARP service before starting it.

## Domain and access control

`https://9router.web-father.ir` continues to reverse proxy to `9router:20128`. `https://warp.web-father.ir` deliberately returns **403** with an access notice. It is **not** a public forward proxy URL. Stock Caddy's HTTP reverse proxy does not relay SOCKS5 or HTTP CONNECT as a forward proxy; using it for that would produce an incorrect endpoint. A public HTTPS forward proxy would require a purpose built Caddy module or another TLS aware forward proxy, plus authentication and a separate review of the exposure.

The actual proxy has no published Docker port and requires credentials even from the shared Docker network. The WARP container drops all Linux capabilities and cannot change host networking. Keep `.env` private because it holds both application and proxy credentials.

## Verify the deployment

Run these commands on the VPS from the deployment directory after `setup.sh`:

```bash
# Container health should become "healthy"; WARP should report "Connected".
docker compose ps warp-proxy
docker compose exec -T warp-proxy warp-cli --accept-tos status

# Compare the public IP and warp= value for normal VPS and proxied requests.
curl -fsS https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|warp)='
docker compose exec -T warp-proxy sh -c \
  'curl -fsS --proxy http://127.0.0.1:8080 --proxy-user "$PROXY_USER:$PROXY_PASS" https://www.cloudflare.com/cdn-cgi/trace' \
  | grep -E '^(ip|warp)='

# The app should respond; the WARP hostname should return 403.
curl -sS -o /dev/null -w '%{http_code}\n' https://9router.web-father.ir
curl -sS -o /dev/null -w '%{http_code}\n' https://warp.web-father.ir
```

The proxied trace must show `warp=on` or `warp=plus`, and its `ip=` must differ from the normal VPS request. The health check performs this same end to end WARP check through the authenticated proxy. The app status can vary with its login flow; it should not be a Caddy `502`.

To verify registration persistence across container recreation, compare the registration identity before and after:

```bash
docker compose exec -T warp-proxy warp-cli --accept-tos registration show
docker compose up -d --force-recreate warp-proxy
docker compose ps warp-proxy
docker compose exec -T warp-proxy warp-cli --accept-tos registration show
```

For host networking and SSH, record `ip -4 route show default` before and after deployment, and connect to the VPS over SSH from a second terminal. The default route should be unchanged. The WARP service has no host network mode or published proxy port.

## Operations and troubleshooting

```bash
docker compose ps
docker compose logs --tail=100 warp-proxy
docker compose logs --tail=100 caddy
docker stats
```

- **WARP unhealthy:** Check `warp-cli --accept-tos status` and WARP logs. The health check requires an authenticated proxy request to Cloudflare's trace endpoint to return `warp=on` or `warp=plus`; registration alone is insufficient.
- **Caddy certificate problem:** Confirm both DNS records resolve to this VPS and inbound TCP `80`/`443` reaches Caddy.
- **Application cannot reach `warp-proxy`:** Confirm it is on `9router-network` and is using port `8080` with the correct credentials. For a separate project, check the external network name.
- **Normal request unexpectedly uses WARP:** Check the application's own proxy settings. This stack does not alter the host default route or set a proxy on 9Router.

The WARP proxy image is maintained by a third party: [image source and usage](https://github.com/foxy1402/warp-proxy-docker). See [Cloudflare's WARP proxy mode explanation](https://blog.cloudflare.com/announcing-warp-for-linux-and-proxy-mode/) and [Caddy's reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy/) for the underlying behavior.
