/**
 * mongosh 风格查询的解析：`db.<集合>.<操作>(...)`。
 *
 * # ⚠️ 这是**第二遍实现**，真身是 Rust 那边
 *
 * 真链路上查询是在 `src-tauri/sql/src/mongo_shell.rs` 里解析的（那边的驱动直接
 * 干活）。这里这一份存在的唯一理由：**浏览器版是 Playwright 唯一能驱动的那条路**
 *（headless 环境起不了原生窗口），而 e2e 要验「点集合 → 生成查询 → 执行 → 看表格」
 * 这条链。
 *
 * 两遍实现就会漂移，而漂移的症状是「e2e 绿的、真机上打不开」——
 * 那正是这个仓库反复记过的那条缝。所以：**语法用例放在共享夹具里**
 *（`tests/fixtures/mongo-queries.json`），两边的测试都拿它跑一遍
 *（Rust: `mongo_shell.rs` 的「契约用例和共享夹具一致」；
 * 这里: `tests/unit/sql-mongo-shell.test.ts`）。
 *
 * # 和 Rust 那份的差别（有意为之，都写在注释里）
 *
 * * 值只落到 JS 的类型上：`ObjectId("…")` 直接给那串十六进制、`ISODate(…)` 给
 *   ISO 字符串（真实现里是 BSON 类型，显示那一层才转成文本）。假实现的数据本来
 *   就是普通 JS 对象，中间再套一层 BSON 形状没有任何收益；
 * * `Regex` 用真的 `RegExp`（假实现的过滤要能跑正则）。
 */

/** 解析出来的一条操作。 */
export type MongoOp =
  | {
      op: 'find';
      filter: Record<string, unknown>;
      projection?: Record<string, unknown>;
      sort?: Record<string, unknown>;
      limit?: number;
      skip?: number;
    }
  | {
      op: 'findOne';
      filter: Record<string, unknown>;
      projection?: Record<string, unknown>;
      sort?: Record<string, unknown>;
      skip?: number;
    }
  | { op: 'count'; filter: Record<string, unknown>; skip?: number; limit?: number }
  | { op: 'estimatedDocumentCount' }
  | { op: 'distinct'; field: string; filter: Record<string, unknown> }
  | { op: 'aggregate'; pipeline: Array<Record<string, unknown>> }
  | { op: 'insertOne'; document: Record<string, unknown> }
  | { op: 'insertMany'; documents: Array<Record<string, unknown>> }
  | {
      op: 'update';
      many: boolean;
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
      upsert: boolean;
    }
  | {
      op: 'replace';
      filter: Record<string, unknown>;
      replacement: Record<string, unknown>;
      upsert: boolean;
    }
  | { op: 'delete'; many: boolean; filter: Record<string, unknown> }
  | {
      op: 'findOneAndUpdate';
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
      upsert: boolean;
      returnAfter: boolean;
    }
  | {
      op: 'findOneAndReplace';
      filter: Record<string, unknown>;
      replacement: Record<string, unknown>;
      upsert: boolean;
      returnAfter: boolean;
    }
  | { op: 'findOneAndDelete'; filter: Record<string, unknown> }
  | { op: 'drop' }
  | {
      op: 'createIndex';
      keys: Record<string, unknown>;
      name?: string;
      unique: boolean;
      sparse: boolean;
      expireAfterSeconds?: number;
    }
  | { op: 'dropIndex'; name: string }
  | { op: 'getIndexes' }
  | { op: 'createCollection'; name: string }
  | { op: 'dropDatabase' };

export interface MongoCommand {
  /** 集合名。库级操作（`db.dropDatabase()`）没有。 */
  collection?: string;
  op: MongoOp;
}

/** 支持的操作（错误信息里要列出来 —— 认不出来时别猜）。 */
const OPS = [
  'find',
  'findOne',
  'countDocuments',
  'count',
  'estimatedDocumentCount',
  'distinct',
  'aggregate',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'drop',
  'createIndex',
  'dropIndex',
  'getIndexes',
] as const;

/**
 * 日期字面量 → ISO 文本。
 *
 * ⚠️ `toISOString()` 给的是 `2026-01-01T00:00:00.000Z`，而 Rust 那边
 * （`bson::DateTime::try_to_rfc3339_string`）给的是 `2026-01-01T00:00:00Z` ——
 * 毫秒那一段是两者唯一的差别，而**显示在同一张表里就是两串不同的文本**，
 * 夹具一比就露。这里把 `.000` 去掉，和真实现对齐。
 */
function isoOrThrow(text: string, who: string): string {
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${who}("${text}") 读不出来`);
  return parsed.toISOString().replace(/\.000Z$/, 'Z');
}

/** 字面量之外的值：认不出来就报错，**不猜**（和 Rust 那份一致）。 */
class Parser {
  private chars: string[];
  private pos = 0;

  constructor(text: string) {
    this.chars = [...text];
  }

  private peek(): string | undefined {
    return this.chars[this.pos];
  }

  private bump(): string | undefined {
    const c = this.peek();
    if (c !== undefined) this.pos += 1;
    return c;
  }

  private skipWs(): void {
    for (;;) {
      const c = this.peek();
      if (c !== undefined && /\s/.test(c)) {
        this.pos += 1;
        continue;
      }
      // `//` 注释到行尾
      if (c === '/' && this.chars[this.pos + 1] === '/') {
        while (this.pos < this.chars.length && this.chars[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  private here(): string {
    const rest = this.chars.slice(this.pos, this.pos + 24).join('');
    return rest === '' ? '（已经到结尾了）' : `…${rest}`;
  }

  private err(what: string): never {
    throw new Error(`${what}（读到 ${this.here()}）`);
  }

  private eat(want: string): boolean {
    this.skipWs();
    if (this.peek() === want) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expect(want: string): void {
    this.skipWs();
    const c = this.bump();
    if (c === want) return;
    if (c === undefined) this.err(`这里应当是 \`${want}\`，但查询结束了）`);
    this.err(`这里应当是 \`${want}\`，读到的是 \`${c}\`）`);
  }

  private identifier(): string {
    this.skipWs();
    const start = this.pos;
    const first = this.peek();
    if (first === undefined) this.err('这里应当是一个名字，但查询结束了）');
    // ⚠️ `\p{L}` 而不是 `A-Za-z`：集合名和字段名都可以是非 ASCII 的
    //（假实现里就是「用户」「订单」）。Rust 那份用的是 `is_alphabetic()`，
    // 两边要一样 —— 这条曾经让一整批用例红在这句「这里应当是一个名字」上
    if (!/[\p{L}_$]/u.test(first)) this.err('这里应当是一个名字（字母、下划线或 $ 开头））');
    this.pos += 1;
    while (this.pos < this.chars.length && /[\p{L}\p{N}_$]/u.test(this.chars[this.pos] ?? '')) {
      this.pos += 1;
    }
    return this.chars.slice(start, this.pos).join('');
  }

  private string(): string {
    this.skipWs();
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") this.err('这里应当是一个字符串（引号包起来））');
    this.pos += 1;
    let out = '';
    for (;;) {
      const c = this.bump();
      if (c === undefined) this.err('字符串没有结尾的引号）');
      if (c === quote) return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const esc = this.bump();
      switch (esc) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case '0':
          out += '\0';
          break;
        case '\\':
        case '"':
        case "'":
        case '/':
          out += esc;
          break;
        case 'u': {
          const hex = this.chars.slice(this.pos, this.pos + 4).join('');
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.err('\\u 后面要跟四个十六进制数字）');
          this.pos += 4;
          out += String.fromCharCode(parseInt(hex, 16));
          break;
        }
        default:
          this.err(`认不出的转义 \`\\${esc ?? ' '}\`（支持 \\n \\t \\r \\\\ \\" \\' \\uXXXX））`);
      }
    }
  }

  private regex(): RegExp {
    this.expect('/');
    let pattern = '';
    for (;;) {
      const c = this.bump();
      if (c === undefined) this.err('正则没有结尾的 `/`）');
      if (c === '\\') {
        pattern += '\\';
        const next = this.bump();
        if (next !== undefined) pattern += next;
        continue;
      }
      if (c === '/') break;
      pattern += c;
    }
    let flags = '';
    while (this.pos < this.chars.length && /[a-z]/i.test(this.chars[this.pos] ?? '')) {
      flags += this.chars[this.pos];
      this.pos += 1;
    }
    return new RegExp(pattern, flags);
  }

  private number(): number {
    this.skipWs();
    const start = this.pos;
    if (this.peek() === '-') this.pos += 1;
    while (this.pos < this.chars.length && /[0-9.eE+-]/.test(this.chars[this.pos] ?? '')) {
      // 指数里的 `+`/`-` 只在 e/E 之后合法，这里用最简单的一条规则：
      // 连续的 [0-9.eE+-] 都吃掉，最后交给 Number() 判
      this.pos += 1;
    }
    const text = this.chars.slice(start, this.pos).join('');
    if (text === '' || text === '-') this.err('这里应当是一个数字）');
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`数字 \`${text}\` 读不出来`);
    return value;
  }

  /** 一个 JS 字面量 → JS 值。 */
  value(): unknown {
    this.skipWs();
    const c = this.peek();
    if (c === '{') return this.document();
    if (c === '[') return this.array();
    if (c === '"' || c === "'") return this.string();
    if (c === '/') return this.regex();
    if (c === '-' || (c !== undefined && /[0-9]/.test(c))) return this.number();
    if (c !== undefined && /[\p{L}_$]/u.test(c)) {
      const word = this.identifier();
      switch (word) {
        case 'true':
          return true;
        case 'false':
          return false;
        case 'null':
          return null;
        case 'ObjectId':
        case 'ObjectID': {
          const hex = this.parenthesisedString();
          if (!/^[0-9a-fA-F]{24}$/.test(hex)) {
            throw new Error(`ObjectId("${hex}") 不是合法的 id（要 24 位十六进制）`);
          }
          // ⚠️ 假实现里直接落成那串十六进制 —— 真实现是 BSON 的 ObjectId，
          // 显示那层再 humanize 成一样的东西（见文件头「和 Rust 那份的差别」）
          return hex;
        }
        case 'ISODate':
        case 'Date': {
          const text = this.parenthesisedString();
          return isoOrThrow(text, 'ISODate');
        }
        case 'new': {
          const what = this.identifier();
          if (what !== 'Date') this.err(`\`new ${what}\` 不支持（只认 new Date("…")））`);
          const text = this.parenthesisedString();
          return isoOrThrow(text, 'new Date');
        }
        default:
          this.err(
            `认不出的值 \`${word}\` —— 字符串要加引号（"${word}"），或者它是个函数的话还没支持）`,
          );
      }
    }
    this.err('这里应当是一个值（数字 / 字符串 / 对象 / 数组 / true / false / null））');
  }

  private parenthesisedString(): string {
    this.expect('(');
    const text = this.string();
    this.expect(')');
    return text;
  }

  private array(): unknown[] {
    this.expect('[');
    const items: unknown[] = [];
    if (this.eat(']')) return items;
    for (;;) {
      items.push(this.value());
      if (this.eat(']')) return items;
      this.expect(',');
      if (this.eat(']')) return items; // 尾随逗号
    }
  }

  private document(): Record<string, unknown> {
    this.expect('{');
    const doc: Record<string, unknown> = {};
    if (this.eat('}')) return doc;
    for (;;) {
      const key = this.objectKey();
      this.expect(':');
      doc[key] = this.value();
      if (this.eat('}')) return doc;
      this.expect(',');
      if (this.eat('}')) return doc;
    }
  }

  private objectKey(): string {
    this.skipWs();
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    if (c !== undefined && /[0-9]/.test(c)) {
      const start = this.pos;
      while (this.pos < this.chars.length && /[0-9.]/.test(this.chars[this.pos] ?? '')) this.pos += 1;
      return this.chars.slice(start, this.pos).join('');
    }
    return this.identifier();
  }

  private args(): unknown[] {
    this.expect('(');
    const out: unknown[] = [];
    if (this.eat(')')) return out;
    for (;;) {
      out.push(this.value());
      if (this.eat(')')) return out;
      this.expect(',');
      if (this.eat(')')) return out;
    }
  }

  private collectionName(): string {
    this.skipWs();
    if (this.peek() === '[') {
      this.expect('[');
      const name = this.string();
      this.expect(']');
      return name;
    }
    this.expect('.');
    const word = this.identifier();
    if (word === 'getCollection') return this.parenthesisedString();
    return word;
  }

  /** 整条命令。 */
  parse(): MongoCommand {
    this.skipWs();
    const word = this.identifier();
    if (word !== 'db') this.err(`查询要从 \`db\` 开始，这里是 \`${word}\`）`);

    // 库级操作（没有集合名）
    const afterDb = this.pos;
    this.skipWs();
    if (this.peek() === '.') {
      this.pos += 1;
      let probed: string | undefined;
      try {
        probed = this.identifier();
      } catch {
        // 连名字都读不出来（`db.123` 那种）—— 往下走，交给 collectionName 报
      }
      if (probed === 'dropDatabase' || probed === 'createCollection') {
        // ⚠️ 位置要停在**名字之后**：`args()` 期待的是那个 `(`
        return this.dbLevelOp(probed);
      }
      if (probed === 'getCollectionNames' || probed === 'stats' || probed === 'version') {
        throw new Error(
          `\`db.${probed}()\` 还不支持。支持的是：db.<集合>.<操作>(...) 或 ` +
            'db.dropDatabase() / db.createCollection(名字)——要列库和集合，直接看左边的树。',
        );
      }
    }
    this.pos = afterDb;

    const collection = this.collectionName();
    this.expect('.');
    const opName = this.identifier();
    const args = this.args();
    let op = this.collectionOp(opName, args);

    // 游标链
    for (;;) {
      this.skipWs();
      if (this.peek() !== '.') break;
      const save = this.pos;
      this.pos += 1;
      let method: string;
      try {
        method = this.identifier();
      } catch {
        this.pos = save;
        break;
      }
      const cursorArgs = this.args();
      op = this.cursorMethod(op, method, cursorArgs);
    }

    return { collection, op };
  }

  private dbLevelOp(name: string): MongoCommand {
    const args = this.args();
    if (name === 'dropDatabase') {
      if (args.length > 0) throw new Error('db.dropDatabase() 不带参数');
      return { op: { op: 'dropDatabase' } };
    }
    const first = args[0];
    if (typeof first !== 'string') {
      throw new Error('db.createCollection("名字") —— 名字要加引号');
    }
    return { op: { op: 'createCollection', name: first } };
  }

  private collectionOp(name: string, args: unknown[]): MongoOp {
    const asDoc = (value: unknown, what: string): Record<string, unknown> => {
      if (value === undefined || value === null) return {};
      if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      throw new Error(`${what} 要是一个对象`);
    };
    const filter = (): Record<string, unknown> => {
      const first = args[0];
      if (first === undefined) return {};
      if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
        return first as Record<string, unknown>;
      }
      throw new Error('filter 要是一个对象，比如 find({age: {$gt: 18}})');
    };
    const optionsOf = (index: number): Record<string, unknown> | undefined => {
      const value = args[index];
      if (value === undefined || value === null) return undefined;
      if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      throw new Error('选项要是一个对象');
    };
    /** 只认 upsert，别的键明说（悄悄忽略比报错坏得多）。 */
    const upsertOf = (index: number): boolean => {
      const options = optionsOf(index);
      if (options === undefined) return false;
      for (const key of Object.keys(options)) {
        if (key !== 'upsert') {
          throw new Error(`更新选项里还不支持 \`${key}\`（现在只认 upsert）`);
        }
      }
      return options['upsert'] === true;
    };
    const pair = (): { filter: Record<string, unknown>; update: Record<string, unknown> } => {
      const update = args[1];
      if (update === undefined || typeof update !== 'object' || update === null || Array.isArray(update)) {
        throw new Error(`\`${name}\` 的第二个参数要是对象，比如 {$set: {name: "李四"}}`);
      }
      return { filter: filter(), update: update as Record<string, unknown> };
    };
    const findAndModifyOptions = (
      index: number,
    ): { returnAfter: boolean; upsert: boolean } => {
      const options = optionsOf(index);
      if (options === undefined) return { returnAfter: false, upsert: false };
      for (const key of Object.keys(options)) {
        if (!['upsert', 'returnDocument', 'returnNew', 'projection', 'fields'].includes(key)) {
          throw new Error(`findOneAnd* 的选项里还不支持 \`${key}\``);
        }
      }
      const returnAfter =
        typeof options['returnDocument'] === 'string'
          ? String(options['returnDocument']).toLowerCase() === 'after'
          : options['returnNew'] === true;
      return { returnAfter, upsert: options['upsert'] === true };
    };

    switch (name) {
      case 'find':
        return { op: 'find', filter: filter(), projection: args[1] === undefined ? undefined : asDoc(args[1], 'projection') };
      case 'findOne':
        return { op: 'findOne', filter: filter(), projection: args[1] === undefined ? undefined : asDoc(args[1], 'projection') };
      case 'countDocuments':
      case 'count': {
        const options = optionsOf(1);
        for (const key of Object.keys(options ?? {})) {
          if (key !== 'skip' && key !== 'limit') {
            throw new Error(`count 的选项里还不支持 \`${key}\`（现在只认 skip 和 limit）`);
          }
        }
        const skip = typeof options?.['skip'] === 'number' ? (options['skip'] as number) : undefined;
        const limit = typeof options?.['limit'] === 'number' ? (options['limit'] as number) : undefined;
        return { op: 'count', filter: filter(), skip, limit };
      }
      case 'estimatedDocumentCount':
        if (args.length > 0) throw new Error('estimatedDocumentCount() 不带参数（要按条件数就用 countDocuments(filter))');
        return { op: 'estimatedDocumentCount' };
      case 'distinct': {
        const field = args[0];
        if (typeof field !== 'string') throw new Error('distinct("字段名") 要一个字段名');
        return { op: 'distinct', field, filter: filter2(args[1]) };
      }
      case 'aggregate': {
        const pipeline = args[0];
        if (!Array.isArray(pipeline)) {
          throw new Error('aggregate 要一个**数组**（管道阶段），比如 aggregate([{$group: {_id: "$city", n: {$sum: 1}}}])');
        }
        return { op: 'aggregate', pipeline: pipeline.map((s) => asDoc(s, 'aggregate 的每个阶段')) };
      }
      case 'insertOne':
        return { op: 'insertOne', document: asDoc(args[0], 'insertOne(文档)') };
      case 'insertMany': {
        const list = args[0];
        if (!Array.isArray(list) || list.length === 0) throw new Error('insertMany([文档, ...]) 要一个非空数组');
        return { op: 'insertMany', documents: list.map((d) => asDoc(d, 'insertMany 的每一项')) };
      }
      case 'updateOne':
      case 'updateMany': {
        const { filter: f, update } = pair();
        return { op: 'update', many: name === 'updateMany', filter: f, update, upsert: upsertOf(2) };
      }
      case 'replaceOne': {
        const { filter: f, update } = pair();
        return { op: 'replace', filter: f, replacement: update, upsert: upsertOf(2) };
      }
      case 'deleteOne':
      case 'deleteMany':
        return { op: 'delete', many: name === 'deleteMany', filter: filter() };
      case 'findOneAndUpdate': {
        const { filter: f, update } = pair();
        const { returnAfter, upsert } = findAndModifyOptions(2);
        return { op: 'findOneAndUpdate', filter: f, update, upsert, returnAfter };
      }
      case 'findOneAndReplace': {
        const { filter: f, update } = pair();
        const { returnAfter, upsert } = findAndModifyOptions(2);
        return { op: 'findOneAndReplace', filter: f, replacement: update, upsert, returnAfter };
      }
      case 'findOneAndDelete':
        return { op: 'findOneAndDelete', filter: filter() };
      case 'drop':
        if (args.length > 0) throw new Error('drop() 不带参数');
        return { op: 'drop' };
      case 'getIndexes':
        return { op: 'getIndexes' };
      case 'createIndex': {
        const keys = asDoc(args[0], 'createIndex({字段: 1})');
        const options = optionsOf(1) ?? {};
        for (const key of Object.keys(options)) {
          if (!['name', 'unique', 'sparse', 'expireAfterSeconds'].includes(key)) {
            throw new Error(`createIndex 的选项里还不支持 \`${key}\`（现在只认 name / unique / sparse / expireAfterSeconds）`);
          }
        }
        return {
          op: 'createIndex',
          keys,
          name: typeof options['name'] === 'string' ? options['name'] : undefined,
          unique: options['unique'] === true,
          sparse: options['sparse'] === true,
          expireAfterSeconds:
            typeof options['expireAfterSeconds'] === 'number' ? options['expireAfterSeconds'] : undefined,
        };
      }
      case 'dropIndex': {
        const first = args[0];
        if (typeof first === 'string') return { op: 'dropIndex', name: first };
        if (typeof first === 'object' && first !== null) {
          const parts = Object.entries(first as Record<string, unknown>).map(([k, v]) => `${k}_${String(v)}`);
          return { op: 'dropIndex', name: parts.join('_') };
        }
        throw new Error('dropIndex("名字") 要一个索引名');
      }
      default:
        throw new Error(
          `不支持的操作：${name}。能用的有：\n查：find / findOne / countDocuments / count / ` +
            `estimatedDocumentCount / distinct / aggregate\n写：insertOne / insertMany / updateOne / ` +
            `updateMany / replaceOne / deleteOne / deleteMany / findOneAndUpdate / findOneAndReplace / ` +
            `findOneAndDelete\n集合：drop / createIndex / dropIndex / getIndexes`,
        );
    }

    /** `distinct` 的第二个参数（filter）单独判一下，别走 `filter()` 那条「第一个参数」的路 */
    function filter2(value: unknown): Record<string, unknown> {
      if (value === undefined || value === null) return {};
      if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      throw new Error('distinct 的第二个参数要是 filter 对象');
    }
  }

  private cursorMethod(op: MongoOp, method: string, args: unknown[]): MongoOp {
    const asDoc = (value: unknown, what: string): Record<string, unknown> => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      throw new Error(`${what} 要一个对象`);
    };
    const asInt = (value: unknown, what: string): number => {
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      throw new Error(`${what} 要一个整数`);
    };

    if (method === 'toArray') return op;
    if (method === 'explain') throw new Error('explain() 还不支持（要看执行计划的话，等这个功能做出来）');

    if (op.op === 'find' || op.op === 'findOne') {
      switch (method) {
        case 'sort':
          return { ...op, sort: asDoc(args[0], 'sort({字段: 1 或 -1})') };
        case 'limit':
          if (op.op !== 'find') throw new Error('findOne 没有 limit（它本来就只取一条）');
          return { ...op, limit: asInt(args[0], 'limit(数字)') };
        case 'skip':
          return { ...op, skip: asInt(args[0], 'skip(数字)') };
        case 'project':
        case 'projection':
          return { ...op, projection: asDoc(args[0], 'project({字段: 1})') };
        case 'count':
          if (args.length > 0) throw new Error('.count() 不带参数（要条件就写在 find 里）');
          return { op: 'count', filter: op.filter };
        default:
          throw new Error(
            `\`${method}()\` 不能跟在这个操作后面。find/findOne 后面能跟的是：sort / limit / skip / project / count / toArray`,
          );
      }
    }
    throw new Error(
      `\`${method}()\` 不能跟在这个操作后面。find/findOne 后面能跟的是：sort / limit / skip / project / count / toArray`,
    );
  }

  /** 整段解析完了没有（多出来的尾巴要说出来）。 */
  finish(): void {
    this.skipWs();
    if (this.peek() === ';') {
      this.pos += 1;
      this.skipWs();
    }
    const c = this.peek();
    if (c !== undefined) this.err(`这里多出来一段看不懂的东西（\`${c}\` 起））`);
  }

  /** 测试用：当前读到的位置（调试时看进度）。 */
  get offset(): number {
    return this.pos;
  }
}

/**
 * 解析一段查询：**`db` 开头走 mongosh 语法，否则当 JSON**（老形式，用户的历史里
 * 躺着那种。真实现那边也是这么分流 —— 见 `mongo_shell.rs`）。
 */
export function parseMongoQuery(text: string, defaultDatabase?: string): MongoCommand & { database?: string } {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('查询是空的。写一句，比如 db.users.find({})');

  if (!isShell(trimmed)) return parseJsonQuery(trimmed, defaultDatabase);

  const parser = new Parser(trimmed);
  const command = parser.parse();
  parser.finish();
  return { ...command, database: defaultDatabase };
}

/** `db` 后面紧跟 `.` 或 `[` 才算 shell 写法（前面的空白和注释先跳掉）。 */
export function isShell(text: string): boolean {
  let rest = text;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('//')) {
      const end = rest.indexOf('\n');
      if (end < 0) return false;
      rest = rest.slice(end + 1);
      continue;
    }
    break;
  }
  if (!rest.startsWith('db')) return false;
  const after = rest.slice(2).replace(/^\s+/, '');
  return after.startsWith('.') || after.startsWith('[');
}

function parseJsonQuery(text: string, defaultDatabase?: string): MongoCommand & { database?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `这段既不是合法的 JSON、也不是 db.<集合>.<操作>(...) 那种写法：${(e as Error).message}\n` +
        '比如：db.users.find({})',
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('查询要是一个 JSON 对象，比如 {"collection":"users"}');
  }
  const q = parsed as Record<string, unknown>;
  const collection = typeof q['collection'] === 'string' ? q['collection'].trim() : '';
  if (collection === '') throw new Error('要指定查哪个集合：{"collection": "users"}');

  const asDoc = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

  return {
    collection,
    database: typeof q['database'] === 'string' ? q['database'] : defaultDatabase,
    op: {
      op: 'find',
      filter: asDoc(q['filter']) ?? {},
      projection: asDoc(q['projection']),
      sort: asDoc(q['sort']),
      limit: typeof q['limit'] === 'number' ? q['limit'] : undefined,
    },
  };
}

/** 支持的操作名（面板上的提示文案用它）。 */
export const SUPPORTED_OPS = OPS;
