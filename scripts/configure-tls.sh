#!/usr/bin/env bash
set -euo pipefail

IP_ADDRESS="${1:?Usage: configure-tls.sh <public-ip-address>}"
WEBROOT=/var/www/certbot
CERTBOT=/snap/bin/certbot
NGINX_SITE=/etc/nginx/sites-available/job-hunters

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this script as root.' >&2
  exit 1
fi

if ! snap list certbot >/dev/null 2>&1; then
  snap install certbot --classic
fi

install -d -m 755 "$WEBROOT/.well-known/acme-challenge"

cat > "$NGINX_SITE" <<NGINX_HTTP
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $IP_ADDRESS;

    location ^~ /.well-known/acme-challenge/ {
        root $WEBROOT;
        default_type text/plain;
    }

    location / {
        proxy_pass http://127.0.0.1:46460;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }

    location /live/ {
        proxy_pass http://127.0.0.1:46460;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }
}
NGINX_HTTP

nginx -t
systemctl reload nginx

if [ ! -f "/etc/letsencrypt/live/$IP_ADDRESS/fullchain.pem" ]; then
  "$CERTBOT" certonly \
    --preferred-profile shortlived \
    --webroot \
    --webroot-path "$WEBROOT" \
    --ip-address "$IP_ADDRESS" \
    --cert-name "$IP_ADDRESS" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --deploy-hook 'systemctl reload nginx'
fi

cat > "$NGINX_SITE" <<NGINX_HTTPS
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $IP_ADDRESS;

    location ^~ /.well-known/acme-challenge/ {
        root $WEBROOT;
        default_type text/plain;
    }

    location / {
        return 301 https://$IP_ADDRESS\$request_uri;
    }
}

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name $IP_ADDRESS;

    ssl_certificate /etc/letsencrypt/live/$IP_ADDRESS/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$IP_ADDRESS/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    location / {
        proxy_pass http://127.0.0.1:46460;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }

    location /live/ {
        proxy_pass http://127.0.0.1:46460;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
    }
}
NGINX_HTTPS

nginx -t
systemctl reload nginx
systemctl enable --now snap.certbot.renew.timer
