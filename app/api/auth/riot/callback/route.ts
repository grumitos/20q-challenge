const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

type CallbackView = {
  status: number;
  eyebrow: string;
  title: string;
  message: string;
};

function bounded(value: string | null, maxLength: number) {
  return value !== null && value.length > 0 && value.length <= maxLength;
}

function callbackView(url: URL): CallbackView {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error !== null) {
    if (!bounded(error, 128) || (errorDescription !== null && !bounded(errorDescription, 512))) {
      return { status: 400, eyebrow: "Solicitud no válida", title: "No pudimos procesar la respuesta", message: "La respuesta de autorización no tenía un formato válido." };
    }
    return { status: error === "access_denied" ? 200 : 400, eyebrow: "Riot Sign On", title: "Autorización cancelada", message: "No se concedió acceso a 20Q Challenge. No se guardó ningún código ni token." };
  }

  if (code === null && state === null) {
    return { status: 200, eyebrow: "Riot Sign On", title: "Callback preparado", message: "Este es el destino seguro de la autorización. La conexión se activará cuando Riot apruebe el cliente RSO." };
  }

  if (!bounded(code, 2048) || !bounded(state, 2048)) {
    return { status: 400, eyebrow: "Solicitud no válida", title: "Faltan datos de autorización", message: "La respuesta no pudo validarse. Vuelve a iniciar la conexión desde 20Q Challenge." };
  }

  return { status: 200, eyebrow: "Riot Sign On", title: "Autorización recibida", message: "La respuesta se recibió de forma segura. El intercambio de tokens se habilitará únicamente después de la aprobación de Riot." };
}

function html(view: CallbackView) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${view.title} | 20Q Challenge</title>
  <style>
    :root{color-scheme:dark;font-family:ui-monospace,"Cascadia Code",Consolas,monospace;background:#0c0b10;color:#eee9f3}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 72% 0%,rgba(141,82,237,.14),transparent 34rem),#0c0b10}
    main{width:min(620px,100%);padding:32px;border:1px solid #302c39;border-radius:6px;background:#111016;box-shadow:0 24px 80px rgba(0,0,0,.28)}
    span{color:#bd9cff;font-size:11px;letter-spacing:.12em;text-transform:uppercase}h1{margin:12px 0 10px;font-size:clamp(25px,6vw,38px);line-height:1.1}p{margin:0;color:#b8b0c1;line-height:1.7}a{display:inline-block;margin-top:24px;color:#dacbff;text-underline-offset:4px}a:focus-visible{outline:2px solid #dacbff;outline-offset:4px}
  </style>
</head>
<body><main><span>${view.eyebrow}</span><h1>${view.title}</h1><p>${view.message}</p><a href="/">Volver a 20Q Challenge</a></main></body>
</html>`;
}

// Riot RSO follows OAuth2 and redirects back with code/state or an error.
// Sources: https://developer.riotgames.com/docs/lol and
// https://nextjs.org/docs/app/api-reference/file-conventions/route
export function GET(request: Request) {
  const view = callbackView(new URL(request.url));
  return new Response(html(view), { status: view.status, headers: SECURITY_HEADERS });
}
