// Windows 的 release 构建不要额外弹一个控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rustdraw_lib::run()
}
