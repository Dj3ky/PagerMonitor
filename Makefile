# PagerMonitor — Makefile
# Run "make help" to see available commands

.DEFAULT_GOAL := help
.PHONY: help setup start start-server start-client stop restart logs build pull update clean

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN  := \033[0;32m
YELLOW := \033[0;33m
RESET  := \033[0m

# ─────────────────────────────────────────────────────────────────────────────

help: ## Show this help
	@echo ""
	@echo "  $(GREEN)PagerMonitor$(RESET) — Makefile commands"
	@echo ""
	@echo "  $(YELLOW)SETUP$(RESET)"
	@echo "  make setup          Copy .env.example to .env (edit before starting)"
	@echo ""
	@echo "  $(YELLOW)OPTION A — Single device (SDR dongle attached to this machine)$(RESET)"
	@echo "  make start          Build and start (single device mode)"
	@echo "  make logs           Follow logs"
	@echo "  make stop           Stop and remove containers"
	@echo "  make restart        Restart containers"
	@echo ""
	@echo "  $(YELLOW)OPTION B — Distributed (server + remote RPi clients)$(RESET)"
	@echo "  make start-server   Start server only (no SDR)"
	@echo "  make start-client   Start RPi SDR client (run on the Pi)"
	@echo ""
	@echo "  $(YELLOW)MAINTENANCE$(RESET)"
	@echo "  make build          Rebuild Docker images"
	@echo "  make update         Pull latest + rebuild + restart"
	@echo "  make clean          Remove containers, images, and volumes (DELETES DATA!)"
	@echo ""

setup: ## Copy .env.example → .env
	@if [ -f .env ]; then \
		echo "$(YELLOW).env already exists — not overwriting$(RESET)"; \
	else \
		cp .env.example .env; \
		echo "$(GREEN)✓ .env created — edit it before starting:$(RESET)"; \
		echo "  nano .env"; \
	fi

start: ## Start in single-device mode (SDR dongle on this machine)
	@echo "$(GREEN)Starting PagerMonitor (single device mode)...$(RESET)"
	docker compose up -d --build
	@echo ""
	@echo "$(GREEN)✓ Running at http://localhost:$$(grep -E '^PORT' .env 2>/dev/null | cut -d= -f2 || echo 3000)$(RESET)"
	@echo "  Default login: admin / admin123 (change immediately!)"
	@echo "  Logs: make logs"

start-server: ## Start server only (no SDR — for Proxmox/NAS/PC)
	@echo "$(GREEN)Starting PagerMonitor server...$(RESET)"
	docker compose --profile server up -d --build
	@echo ""
	@echo "$(GREEN)✓ Server running. Go to Admin → SDR Client Key to get the client key.$(RESET)"

start-client: ## Start RPi SDR client (run this on the Raspberry Pi)
	@echo "$(GREEN)Starting PagerMonitor client...$(RESET)"
	@if [ ! -f client/.env ]; then \
		echo "$(YELLOW)client/.env not found — copying example:$(RESET)"; \
		cp client/.env.example client/.env; \
		echo "Edit client/.env then run make start-client again."; \
		exit 1; \
	fi
	docker compose -f docker-compose.client.yml up -d --build

stop: ## Stop and remove containers
	docker compose down
	-docker compose -f docker-compose.client.yml down 2>/dev/null

restart: ## Restart all containers
	docker compose restart

logs: ## Follow container logs
	docker compose logs -f

build: ## Rebuild Docker images without cache
	docker compose build --no-cache

update: ## Pull latest code, rebuild, and restart
	git pull
	docker compose down
	docker compose up -d --build
	@echo "$(GREEN)✓ Updated and restarted$(RESET)"

clean: ## Remove everything including data volume (DELETES DATABASE!)
	@echo "$(YELLOW)WARNING: This will delete the database and all messages!$(RESET)"
	@read -p "Type 'yes' to confirm: " confirm && [ "$$confirm" = "yes" ] || exit 1
	docker compose down -v
	docker rmi pagermonitor:latest pagermonitor-server:latest pagermonitor-client:latest 2>/dev/null || true
	@echo "$(GREEN)✓ Cleaned up$(RESET)"
