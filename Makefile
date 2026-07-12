NEO4J_CONTAINER := neo4j
NEO4J_PASSWORD := test12345
NEO4J_IMAGE := neo4j:5
DATA_DIR := $(CURDIR)/data/neo4j

.PHONY: up down start stop logs shell clean

up:
	mkdir -p $(DATA_DIR)/data $(DATA_DIR)/logs $(DATA_DIR)/import
	docker run -d \
		--name $(NEO4J_CONTAINER) \
		-p 7474:7474 -p 7687:7687 \
		-e NEO4J_AUTH=neo4j/$(NEO4J_PASSWORD) \
		-v $(DATA_DIR)/data:/data \
		-v $(DATA_DIR)/logs:/logs \
		-v $(DATA_DIR)/import:/var/lib/neo4j/import \
		$(NEO4J_IMAGE)
	@echo "Neo4j starting... open http://localhost:7474 (user: neo4j / pass: $(NEO4J_PASSWORD))"

down:
	docker rm -f $(NEO4J_CONTAINER)

start:
	docker start $(NEO4J_CONTAINER)

stop:
	docker stop $(NEO4J_CONTAINER)

logs:
	docker logs -f $(NEO4J_CONTAINER)

shell:
	docker exec -it $(NEO4J_CONTAINER) cypher-shell -u neo4j -p $(NEO4J_PASSWORD)

clean: down
	rm -rf $(DATA_DIR)
