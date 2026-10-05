export function getServerConfig(env: Record<string, string | undefined>) {
  const port = Number(env.PORT?.trim() || "8081");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  const hostname = env.HOST?.trim() || "127.0.0.1";
  const baseUrl = (env.BASE_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("BASE_URL must be an HTTP or HTTPS origin"); }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("BASE_URL must be an HTTP or HTTPS origin");
  }
  return { port, hostname, baseUrl };
}
