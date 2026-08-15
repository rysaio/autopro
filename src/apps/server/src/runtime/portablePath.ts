/**
 * Windows → WSL/Linux 路径兼容层。
 *
 * 从 Windows 迁到 WSL 时，旧 .env / mcp.json / plugin .mcp.json 里可能残留：
 *   C:\work\runtime
 *   C:/work/runtime
 *   \\wsl$\Ubuntu\home\...
 * 这些字符串在 Linux path 模块下会被当作普通相对路径，导致数据写入错误目录。
 */
export function normalizePortablePath(value: string): string {
  if (process.platform === "win32" || !value) {
    return value;
  }
  const drivePath = /^([a-zA-Z]):[\\/](.*)$/.exec(value);
  if (drivePath) {
    const rest = drivePath[2]?.replace(/[\\/]+/g, "/").replace(/^\/+/, "") ?? "";
    return `/mnt/${drivePath[1]?.toLowerCase() ?? "c"}/${rest}`;
  }
  const wslUnc = /^\\\\wsl(?:\.localhost)?\$?[\\/]([^\\/]+)[\\/](.*)$/i.exec(value);
  if (wslUnc) {
    return `/${(wslUnc[2] ?? "").replace(/[\\/]+/g, "/").replace(/^\/+/, "")}`;
  }
  return value;
}
