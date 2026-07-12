
// 创建node
CREATE (liubei:Person {name: '刘备', kingdom: '蜀'})
CREATE (guanyu:Person {name: '关羽', kingdom: '蜀'})
CREATE (zhangfei:Person {name: '张飞', kingdom: '蜀'})
CREATE (zhaoyun:Person {name: '赵云', kingdom: '蜀'})
CREATE (zhugeliang:Person {name: '诸葛亮', kingdom: '蜀'})
CREATE (caocao:Person {name: '曹操', kingdom: '魏'})
CREATE (xunyu:Person {name: '荀彧', kingdom: '魏'})
CREATE (simayi:Person {name: '司马懿', kingdom: '魏'})
CREATE (sunquan:Person {name: '孙权', kingdom: '吴'})
CREATE (zhouyu:Person {name: '周瑜', kingdom: '吴'})
CREATE (lusu:Person {name: '鲁肃', kingdom: '吴'})

// 创建关系
// 注意：分开执行的语句之间变量不共享，所以这里改用 MATCH 按 name 重新找节点再建关系

// 桃园三结义
MATCH (a:Person {name:'刘备'}), (b:Person {name:'关羽'}) CREATE (a)-[:SWORN_BROTHER]->(b)
MATCH (a:Person {name:'刘备'}), (b:Person {name:'张飞'}) CREATE (a)-[:SWORN_BROTHER]->(b);
MATCH (a:Person {name:'关羽'}), (b:Person {name:'张飞'}) CREATE (a)-[:SWORN_BROTHER]->(b);

// 蜀：武将效力 + 军师献策
MATCH (a:Person {name:'关羽'}), (b:Person {name:'刘备'}) CREATE (a)-[:SERVES]->(b)
MATCH (a:Person {name:'张飞'}), (b:Person {name:'刘备'}) CREATE (a)-[:SERVES]->(b)
MATCH (a:Person {name:'赵云'}), (b:Person {name:'刘备'}) CREATE (a)-[:SERVES]->(b)
MATCH (a:Person {name:'诸葛亮'}), (b:Person {name:'刘备'}) CREATE (a)-[:ADVISES]->(b)

// 魏：军师献策
MATCH (a:Person {name:'荀彧'}), (b:Person {name:'曹操'}) CREATE (a)-[:ADVISES]->(b);
MATCH (a:Person {name:'司马懿'}), (b:Person {name:'曹操'}) CREATE (a)-[:ADVISES]->(b);

// 吴：军师献策
MATCH (a:Person {name:'周瑜'}), (b:Person {name:'孙权'}) CREATE (a)-[:ADVISES]->(b);
MATCH (a:Person {name:'鲁肃'}), (b:Person {name:'孙权'}) CREATE (a)-[:ADVISES]->(b);

// 跨阵营的敌对/宿敌关系（后面用来跑最短路径很好玩）
MATCH (a:Person {name:'刘备'}), (b:Person {name:'曹操'}) CREATE (a)-[:RIVAL_OF]->(b);
MATCH (a:Person {name:'曹操'}), (b:Person {name:'孙权'}) CREATE (a)-[:ENEMY_OF]->(b);
MATCH (a:Person {name:'诸葛亮'}), (b:Person {name:'司马懿'}) CREATE (a)-[:RIVAL_OF]->(b);

1. 建节点 — CREATE

cypher
CREATE (liubei:Person {name: '刘备', kingdom: '蜀'})
(变量:标签 {属性}) 是固定套路。标签相当于"类型/表名"，属性是键值对。

2. 建关系 — -[:TYPE]->

cypher
CREATE (liubei)-[:SWORN_BROTHER]->(guanyu)
关系必须连接已存在的节点变量，方向用箭头表示（可以是有方向的，也可以查询时忽略方向）。

3. 避免重复 — MERGE

CREATE 每次都新建，重复跑会出现重复节点。MERGE 是"有则用，没有则建"，写脚本时更安全：
cypher
MERGE (p:Person {name: '关羽'})

4. 查询 — MATCH ... WHERE ... RETURN

cypher
MATCH (p:Person)-[:SERVES]->(lord:Person {name: '刘备'})
RETURN p.name
MATCH 描述一个"图形状"，Neo4j 去图里找符合这个形状的所有匹配。这是和 SQL 最大的区别——SQL 要写 join，这里是画图案。

5. 多跳/路径查询 — 这是图数据库的看家本领

cypher
// 找 A 到 B 之间任意长度的路径
MATCH path = (a:Person {name:'刘备'})-[*1..4]-(b:Person {name:'司马懿'})
RETURN path

// 最短路径
MATCH path = shortestPath((a:Person {name:'刘备'})-[*]-(b:Person {name:'司马懿'}))
RETURN path
[*1..4] 表示中间跳 1 到 4 层关系，不用管中间经过谁。

6. 删除 — DETACH DELETE

cypher
MATCH (p:Person {name:'张飞'}) DETACH DELETE p
DETACH 表示连带这个节点的所有关系一起删，否则有关系挂着的节点删不掉。


建完之后跑几条体会一下：
1. 查刘备的所有直接关系（1跳）
2. 查诸葛亮到司马懿的最短路径（会经过几层？）
3. 查某个阵营下所有人物
4. 试着写一条"找两个不同阵营但有关系的人"

过滤 + 聚合
4. 统计每个阵营（kingdom）各有多少人
5. 查有"军师"（ADVISES 关系）效力的君主分别是谁

图的核心：多跳与路径
6. 刘备和司马懿之间有没有路径？用 [*] 不限跳数试试，看看能不能连起来
7. 用 shortestPath() 查刘备到司马懿的最短路径，中间经过谁、几跳
8. 查诸葛亮的"二度人脉"——即通过一个中间人能连到的所有人（[*2] 精确两跳）

对比 SQL 思维的题（重点体会）
9. 找"和刘备有关系，同时也和曹操有关系"的人（如果有的话）——这种"共同好友"查询在 SQL 里要写两次 join，Cypher 一个 MATCH 模式就能表达
10. 试着删掉某条关系（比如刘备和曹操的 RIVAL_OF），再重新跑第 6/7 题，看路径怎么变——直观感受"图的形状变了，可达性就变了"

```shell
# 查蜀国所有人
MATCH (p:Person {kingdom: '蜀'})
RETURN p.name

# 查询和刘备的所有关系
MATCH (p:Person {name: '刘备'})-[r]-(b)
RETURN p,r,b

# 查谁效力于刘备
MATCH (p:Person {name: '刘备'})<-[r:SERVES]-(b)
RETURN p,r,b

# 隐式分组, 每个郭有多少人
MATCH (p:Person)
RETURN p.kingdom, count(p)

# 有军师效力的君主，去重机制
MATCH (p:Person) <- [:ADVISES] - (b)
RETURN DISTINCT p.name


# 刘备和司马懿之间有没有路径，
MATCH path = (p:Person {name: '刘备'}) - [*] - (b:Person {name: '司马懿'})
RETURN path

# 刘备和司马懿之间最短路径
MATCH path = shortestPath((p:Person {name: '刘备'}) - [*] - (b:Person {name: '司马懿'}))
RETURN path

# 诸葛亮的2度人脉
MATCH path = (p:Person {name: '诸葛亮'}) - [*2] - (b)
RETURN path


# 所有任务以及关系
MATCH (p:Person)-[r]-(m:Person)
RETURN p,r,m
```