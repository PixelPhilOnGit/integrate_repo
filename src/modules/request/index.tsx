/**
 * 「接口调试」模块的入口。
 *
 * 「加一个模块 = 一个目录 + 注册表里一行」，这里就是那一行指向的东西。
 *
 * # 它是什么
 *
 * 一个**类似 Postman 的页签**：填地址、选方法、加头、发出去、看回来什么。
 * 协议范围一期是 **HTTP / HTTPS**（WS 还没做，见 HANDOFF 里那一步）。
 *
 * # 和另外两个「发网络请求」的模块的区别
 *
 * | | 智能体会话 | 助手 | 这个 |
 * |---|---|---|---|
 * | 请求是谁编的 | 那些 CLI 自己 | 我们（provider 的格式） | **用户自己** |
 * | 关心什么 | 进程状态 | 一轮对话的完整性 | **这个响应长什么样** |
 *
 * 传输层是**同一份**（`devtoolkit-request`）：TLS 的 provider 钉死、Host 头怎么算、
 * 保留头怎么 sanitize、跳转怎么跟 —— 只有一处实现，不会在两个消费者之间漂移。
 *
 * # 这一版**不做**什么（都是想清楚才砍的）
 *
 * * **环境变量 / 变量替换** —— 那是另一件大工程（变量表、作用域、替换规则），
 *   用户拍板的是「侧栏放历史 + 保存的请求」；
 * * **停止一个正在跑的请求** —— 要在读循环里插一个可等待的取消信号，
 *   而那个循环在传输层里。代价是「一直不结束的响应只能等空闲超时」，
 *   见 `src-tauri/src/request_commands.rs` 头部那段（那里有完整的取舍）；
 * * **二进制 body**（选个文件当 body）—— 传输层支持任意字节，界面上还没入口；
 * * **WebSocket** —— 排在最后一步，`tokio-tungstenite` 那两个包还没加。
 */

import type { Module } from '../../shell/types';
import { RequestIcon } from './icon';
import {
  RequestInspector,
  RequestMain,
  RequestSidebar,
  RequestStatusItems,
  RequestToolbar,
} from './RequestModule';
import { requestStore } from './state/store';

export const requestModule: Module = {
  id: 'request',
  name: '接口调试',
  icon: <RequestIcon />,

  // Toolbar 槽位此前只有顺序图在用 —— 「方法 + 地址 + 发送」正好是它
  Toolbar: RequestToolbar,
  Sidebar: RequestSidebar,
  Main: RequestMain,
  Inspector: RequestInspector,
  StatusItems: RequestStatusItems,

  // 它不往工作区写文件（历史和保存走键值库），所以不列任何后缀
  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    // 接上外壳（失败提示交给它显示），然后把历史和保存读出来。
    // `init()` 是幂等的：切走再切回来不会把编辑器里那份草稿重置掉
    requestStore.attachShell(api);
    void requestStore.init();
  },
};
