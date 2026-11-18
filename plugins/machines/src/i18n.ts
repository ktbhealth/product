export const MACHINE_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into — matches the plugin-id
 * domain (`machines.*` → `machines`). */
export const I18N_NAMESPACE = "machines";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): MachineMessages => machineMessages(locale);

export interface MachineMessages {
	readonly title: string;
	readonly desc: string;
	readonly add: string;
	readonly name: string;
	readonly kind: string;
	readonly host: string;
	readonly port: string;
	readonly capabilities: string;
	readonly capabilitiesHint: string;
	readonly secretRef: string;
	readonly secretRefHint: string;
	readonly healthUrl: string;
	readonly status: string;
	readonly statusUnknown: string;
	readonly statusOnline: string;
	readonly statusOffline: string;
	readonly statusDraining: string;
	readonly lastSeen: string;
	readonly lastCheck: string;
	readonly check: string;
	readonly checkAll: string;
	readonly save: string;
	readonly cancel: string;
	readonly delete: string;
	readonly confirmDelete: string;
	readonly enable: string;
	readonly disable: string;
	readonly empty: string;
	readonly actionFailed: string;
}

const en: MachineMessages = {
	title: "Machines",
	desc: "Registered shells, VMs and endpoints workloads can run on — health only, no execution here.",
	add: "Register machine",
	name: "Name",
	kind: "Kind",
	host: "Host",
	port: "Port",
	capabilities: "Capabilities",
	capabilitiesHint: "Comma-separated workload kinds (acp, eval-runner, tts, asr, llm)",
	secretRef: "Secret ref",
	secretRefHint: "vault:<id> — auth material stays in the vault",
	healthUrl: "Health URL",
	status: "Status",
	statusUnknown: "Unknown",
	statusOnline: "Online",
	statusOffline: "Offline",
	statusDraining: "Draining",
	lastSeen: "Last seen",
	lastCheck: "Last check",
	check: "Check",
	checkAll: "Check all",
	save: "Save",
	cancel: "Cancel",
	delete: "Delete",
	confirmDelete: "Delete this machine? This cannot be undone.",
	enable: "Enable",
	disable: "Disable",
	empty: "No machines registered yet.",
	actionFailed: "Action failed — check permissions and try again.",
};

const ptBR: MachineMessages = {
	title: "Máquinas",
	desc: "Shells, VMs e endpoints registrados onde workloads podem rodar — só saúde, sem execução aqui.",
	add: "Registrar máquina",
	name: "Nome",
	kind: "Tipo",
	host: "Host",
	port: "Porta",
	capabilities: "Capacidades",
	capabilitiesHint: "Tipos de workload separados por vírgula (acp, eval-runner, tts, asr, llm)",
	secretRef: "Ref de segredo",
	secretRefHint: "vault:<id> — o material de auth fica no vault",
	healthUrl: "URL de saúde",
	status: "Status",
	statusUnknown: "Desconhecido",
	statusOnline: "Online",
	statusOffline: "Offline",
	statusDraining: "Drenando",
	lastSeen: "Visto por último",
	lastCheck: "Última verificação",
	check: "Verificar",
	checkAll: "Verificar todas",
	save: "Salvar",
	cancel: "Cancelar",
	delete: "Excluir",
	confirmDelete: "Excluir esta máquina? Isso não pode ser desfeito.",
	enable: "Ativar",
	disable: "Desativar",
	empty: "Nenhuma máquina registrada ainda.",
	actionFailed: "Ação falhou — verifique as permissões e tente novamente.",
};

const es: MachineMessages = {
	title: "Máquinas",
	desc: "Shells, VMs y endpoints registrados donde pueden correr workloads — solo salud, sin ejecución aquí.",
	add: "Registrar máquina",
	name: "Nombre",
	kind: "Tipo",
	host: "Host",
	port: "Puerto",
	capabilities: "Capacidades",
	capabilitiesHint: "Tipos de workload separados por coma (acp, eval-runner, tts, asr, llm)",
	secretRef: "Ref de secreto",
	secretRefHint: "vault:<id> — el material de auth queda en el vault",
	healthUrl: "URL de salud",
	status: "Estado",
	statusUnknown: "Desconocido",
	statusOnline: "En línea",
	statusOffline: "Fuera de línea",
	statusDraining: "Drenando",
	lastSeen: "Visto por última vez",
	lastCheck: "Última verificación",
	check: "Verificar",
	checkAll: "Verificar todas",
	save: "Guardar",
	cancel: "Cancelar",
	delete: "Eliminar",
	confirmDelete: "¿Eliminar esta máquina? No se puede deshacer.",
	enable: "Activar",
	disable: "Desactivar",
	empty: "Aún no hay máquinas registradas.",
	actionFailed: "La acción falló — revisa los permisos e inténtalo de nuevo.",
};

const messages: Record<string, MachineMessages> = { en, "pt-BR": ptBR, es };

export const machineMessages = (locale: string): MachineMessages =>
	messages[locale] ?? messages.en!;
