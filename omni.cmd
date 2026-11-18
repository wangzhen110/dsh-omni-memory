@echo off
rem 全息记忆 · 命令行入口。把本目录加入 PATH 后即可直接 `omni context`。
node "%~dp0hosts\cli.mjs" %*
