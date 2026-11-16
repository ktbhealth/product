/** AI endpoints copy — one typed catalog per locale, resolved from
 * the panel page ctx (same contract as eval-validator's i18n). */
export const AI_ENDPOINT_LOCALES = ["en", "pt-BR", "es"] as const;

export interface AiEndpointMessages {
	readonly endpointsTitle: string;
	readonly endpointsDesc: string;
	readonly newEndpoint: string;
	readonly edit: string;
	readonly confirmDelete: string;
	readonly cancel: string;
	readonly save: string;
	readonly name: string;
	readonly kind: string;
	readonly baseUrl: string;
	readonly model: string;
	readonly sessionId: string;
	readonly secretRef: string;
	readonly secretRefHint: string;
	readonly secretRefNone: string;
	readonly secretRefCustom: string;
	readonly scopeLabel: string;
	readonly isDefaultLabel: string;
	readonly timeoutMs: string;
	readonly enabled: string;
	readonly test: string;
	readonly testOk: string;
	readonly testFailed: string;
	readonly transport: string;
	readonly transportHint: string;
	readonly agentCmd: string;
	readonly agentCmdHint: string;
	readonly sshHost: string;
	readonly acpHint: string;
	readonly emptyEndpoints: string;
	readonly actionFailed: string;
	readonly setPlatformDefault: string;
	readonly bridgeBadge: string;
	readonly baseUrlBridgeHint: string;
	readonly bridgeConnect: string;
	readonly bridgeTitle: string;
	readonly bridgeDesc: string;
	readonly bridgeCopy: string;
	readonly bridgeCopied: string;
	readonly bridgeWaiting: string;
	readonly bridgeConnected: string;
	readonly bridgeOffline: string;
	readonly bridgeClose: string;
}

const en: AiEndpointMessages = {
	endpointsTitle: "Endpoints",
	endpointsDesc:
		"Generative providers any AI surface can bind — secrets resolve through Credentials, never the table.",
	newEndpoint: "New endpoint",
	edit: "Edit",
	confirmDelete: "Confirm delete",
	cancel: "Cancel",
	save: "Save",
	name: "Name",
	kind: "Kind",
	baseUrl: "Base URL",
	model: "Model",
	sessionId: "Session id",
	secretRef: "API key env var",
	secretRefHint: "Name of the env var holding the key — never the key itself.",
	secretRefNone: "None",
	secretRefCustom: "Custom env var",
	scopeLabel: "Scope",
	isDefaultLabel: "Default endpoint",
	timeoutMs: "Timeout (ms)",
	enabled: "Enabled",
	test: "Test",
	testOk: "endpoint ok",
	testFailed: "endpoint failed",
	transport: "Transport",
	transportHint: "child/ssh need the Node runtime — this app only drives ws.",
	agentCmd: "Agent command",
	agentCmdHint: "Command the Node runtime spawns — e.g. `claude agent acp` or `gemini --acp`.",
	sshHost: "SSH host",
	acpHint:
		"Connects a local agent over ACP (e.g. Claude Code). No API key needed — run `claude agent acp` and paste the session id.",
	emptyEndpoints: "No endpoints — generation falls back to the template renderer.",
	actionFailed: "Action failed — check permissions and try again.",
	setPlatformDefault: "Set as platform default",
	bridgeBadge: "bridge",
	baseUrlBridgeHint: "Leave empty on acp+ws to connect a local agent through the bridge.",
	bridgeConnect: "Connect via bridge",
	bridgeTitle: "Connect agent via bridge",
	bridgeDesc:
		"Run this command on the machine that hosts the agent — it mints a one-shot link (shown once, ~15min). The agent command stays local: the server only ever sends frames.",
	bridgeCopy: "Copy command",
	bridgeCopied: "Copied",
	bridgeWaiting: "waiting for the CLI to connect",
	bridgeConnected: "bridge connected",
	bridgeOffline: "bridge offline",
	bridgeClose: "Close",
};

const ptBR: AiEndpointMessages = {
	...en,
	endpointsTitle: "Endpoints",
	endpointsDesc:
		"Provedores generativos que qualquer superfície de IA pode usar — segredos resolvem via Credenciais, nunca a tabela.",
	newEndpoint: "Novo endpoint",
	edit: "Editar",
	confirmDelete: "Confirmar exclusão",
	cancel: "Cancelar",
	save: "Salvar",
	name: "Nome",
	kind: "Tipo",
	baseUrl: "URL base",
	model: "Modelo",
	sessionId: "Id de sessão",
	secretRef: "Env var da API key",
	secretRefHint: "Nome da env var que guarda a chave — nunca a chave em si.",
	secretRefNone: "Nenhuma",
	secretRefCustom: "Env var personalizada",
	scopeLabel: "Escopo",
	isDefaultLabel: "Endpoint padrão",
	timeoutMs: "Timeout (ms)",
	enabled: "Ativo",
	test: "Testar",
	testOk: "endpoint ok",
	testFailed: "endpoint falhou",
	transport: "Transporte",
	transportHint: "child/ssh precisam do runtime Node — este app só usa ws.",
	agentCmd: "Comando do agente",
	agentCmdHint: "Comando que o runtime Node executa — ex.: `claude agent acp` ou `gemini --acp`.",
	sshHost: "Host SSH",
	acpHint:
		"Conecta um agente local via ACP (ex.: Claude Code). Sem API key — rode `claude agent acp` e cole o id de sessão.",
	emptyEndpoints: "Sem endpoints — a geração usa o renderizador de template.",
	actionFailed: "Ação falhou — verifique permissões e tente de novo.",
	setPlatformDefault: "Definir como padrão da plataforma",
	bridgeBadge: "bridge",
	baseUrlBridgeHint: "Deixe vazio em acp+ws para conectar um agente local pela bridge.",
	bridgeConnect: "Conectar via bridge",
	bridgeTitle: "Conectar agente via bridge",
	bridgeDesc:
		"Execute este comando na máquina que hospeda o agente — ele gera um link de uso único (exibido uma vez, ~15min). O comando do agente fica local: o servidor só envia frames.",
	bridgeCopy: "Copiar comando",
	bridgeCopied: "Copiado",
	bridgeWaiting: "aguardando a CLI conectar",
	bridgeConnected: "bridge conectada",
	bridgeOffline: "bridge offline",
	bridgeClose: "Fechar",
};

const es: AiEndpointMessages = {
	...ptBR,
	...en,
	endpointsDesc:
		"Proveedores generativos que cualquier superficie de IA puede usar — los secretos se resuelven vía Credenciales, nunca la tabla.",
	newEndpoint: "Nuevo endpoint",
	edit: "Editar",
	confirmDelete: "Confirmar eliminación",
	cancel: "Cancelar",
	save: "Guardar",
	name: "Nombre",
	scopeLabel: "Ámbito",
	isDefaultLabel: "Endpoint predeterminado",
	test: "Probar",
	transport: "Transporte",
	transportHint: "child/ssh necesitan el runtime Node — esta app solo usa ws.",
	agentCmd: "Comando del agente",
	agentCmdHint: "Comando que el runtime Node ejecuta — p. ej. `claude agent acp` o `gemini --acp`.",
	sshHost: "Host SSH",
	acpHint:
		"Conecta un agente local vía ACP (p. ej. Claude Code). Sin API key — ejecuta `claude agent acp` y pega el id de sesión.",
	secretRefNone: "Ninguna",
	secretRefCustom: "Env var personalizada",
	actionFailed: "La acción falló — revisa permisos e intenta de nuevo.",
	setPlatformDefault: "Establecer como predeterminado de la plataforma",
	bridgeBadge: "bridge",
	baseUrlBridgeHint: "Deja vacío en acp+ws para conectar un agente local por el bridge.",
	bridgeConnect: "Conectar vía bridge",
	bridgeTitle: "Conectar agente vía bridge",
	bridgeDesc:
		"Ejecuta este comando en la máquina que hospeda el agente — genera un enlace de un solo uso (se muestra una vez, ~15min). El comando del agente queda local: el servidor solo envía frames.",
	bridgeCopy: "Copiar comando",
	bridgeCopied: "Copiado",
	bridgeWaiting: "esperando que la CLI conecte",
	bridgeConnected: "bridge conectado",
	bridgeOffline: "bridge sin conexión",
	bridgeClose: "Cerrar",
};

export const aiEndpointMessages = (locale: string): AiEndpointMessages =>
	locale === "pt-BR" ? ptBR : locale === "es" ? es : en;
