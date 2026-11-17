/**
 * Vault plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the page ctx and views resolve their strings
 * here. A locale catalog must implement `VaultMessages` in full — a
 * missing key is a type error, not an English fallback.
 */

export const VAULT_LOCALES = ["en", "pt-BR", "es"] as const;
export type VaultLocale = (typeof VAULT_LOCALES)[number];
export const BASE_LOCALE: VaultLocale = "en";

export const isVaultLocale = (locale: string): locale is VaultLocale =>
	(VAULT_LOCALES as readonly string[]).includes(locale);

export interface VaultMessages {
	readonly title: string;
	readonly description: string;
	readonly personalScope: string;
	readonly zkOn: string;
	readonly zkOff: string;
	readonly nonZkTitle: string;
	readonly nonZkMember: string;
	readonly nonZkAdmin: string;
	readonly enableZk: string;
	readonly phraseTitle: string;
	readonly phraseWarning: string;
	readonly phraseConfirm: string;
	readonly copy: string;
	readonly copied: string;
	readonly cancel: string;
	readonly devicesTitle: string;
	readonly devicesEmpty: string;
	readonly colDevice: string;
	readonly colMember: string;
	readonly colStatus: string;
	readonly colCreated: string;
	readonly colActions: string;
	readonly thisDevice: string;
	readonly statusPending: string;
	readonly statusApproved: string;
	readonly statusRevoked: string;
	readonly enrollThisDevice: string;
	readonly pendingApproval: string;
	readonly approve: string;
	readonly approveTitle: string;
	readonly approveDescription: (userId: string) => string;
	readonly revoke: string;
	readonly revokeTitle: string;
	readonly revokeDescription: (userId: string) => string;
	readonly restoreTitle: string;
	readonly restoreDescription: string;
	readonly phrasePlaceholder: string;
	readonly restore: string;
	readonly actionFailed: string;
	/** BYOK card (T-146): clinic-configured provider key for ZK
	 * anamnesis extraction — sealed to this device. */
	readonly byokTitle: string;
	readonly byokDescription: string;
	readonly byokConfigured: string;
	readonly byokNotConfigured: string;
	readonly byokModelLabel: string;
	readonly byokBaseUrlLabel: string;
	readonly byokApiKeyLabel: string;
	readonly byokSave: string;
	readonly byokClear: string;
}

const en: VaultMessages = {
	title: "Clinic vault",
	description: "Zero-knowledge encryption keys for this clinic's records.",
	personalScope: "Select a clinic workspace to manage its encryption keys.",
	zkOn: "Zero-knowledge on",
	zkOff: "Zero-knowledge off",
	nonZkTitle: "Zero-knowledge records are off",
	nonZkMember: "This clinic has not enabled zero-knowledge records. Ask a clinic admin.",
	nonZkAdmin:
		"Enable end-to-end encryption for this clinic's records. This is permanent — records created afterwards are only readable on approved devices.",
	enableZk: "Enable zero-knowledge",
	phraseTitle: "Save the clinic recovery phrase",
	phraseWarning:
		"This phrase is the only copy of the clinic's master key. Print it or write it down and store it somewhere safe — if every approved device is lost, only this phrase can recover the records.",
	phraseConfirm: "I stored the recovery phrase safely",
	copy: "Copy",
	copied: "Copied",
	cancel: "Cancel",
	devicesTitle: "Member devices",
	devicesEmpty: "No devices enrolled yet.",
	colDevice: "Device key",
	colMember: "Member",
	colStatus: "Status",
	colCreated: "Enrolled",
	colActions: "Actions",
	thisDevice: "this device",
	statusPending: "Pending",
	statusApproved: "Approved",
	statusRevoked: "Revoked",
	enrollThisDevice: "Enroll this device",
	pendingApproval: "Waiting for a clinic admin to approve this device.",
	approve: "Approve",
	approveTitle: "Approve device",
	approveDescription: (userId) =>
		`Grant this device access to the clinic's encrypted records (member ${userId})?`,
	revoke: "Revoke",
	revokeTitle: "Revoke device",
	revokeDescription: (userId) =>
		`Remove this device's access to the clinic's encrypted records (member ${userId})? Existing records stay encrypted for the remaining devices.`,
	restoreTitle: "Restore from recovery phrase",
	restoreDescription: "Enter the clinic recovery phrase to activate the master key on this device.",
	phrasePlaceholder: "xxxx-xxxx-xxxx-…",
	restore: "Restore",
	actionFailed: "The action failed — try again.",
	byokTitle: "LLM extraction key (BYOK)",
	byokDescription:
		"Optional. With your own provider key, anamnesis extraction calls your LLM provider directly from this device — transcripts never pass through KTB servers. Without it, the local heuristic extractor runs.",
	byokConfigured: "A provider key is stored on this device (encrypted).",
	byokNotConfigured: "No provider key on this device — the local heuristic extractor runs.",
	byokModelLabel: "Model",
	byokBaseUrlLabel: "Endpoint URL",
	byokApiKeyLabel: "Provider API key",
	byokSave: "Save key",
	byokClear: "Remove key",
};

const ptBR: VaultMessages = {
	title: "Cofre da clínica",
	description: "Chaves de criptografia de conhecimento zero dos registros desta clínica.",
	personalScope: "Selecione um espaço de clínica para gerenciar suas chaves de criptografia.",
	zkOn: "Conhecimento zero ativo",
	zkOff: "Conhecimento zero inativo",
	nonZkTitle: "Registros de conhecimento zero estão inativos",
	nonZkMember:
		"Esta clínica ainda não ativou os registros de conhecimento zero. Peça a um administrador da clínica.",
	nonZkAdmin:
		"Ative a criptografia de ponta a ponta dos registros desta clínica. Isso é permanente — registros criados depois só podem ser lidos em dispositivos aprovados.",
	enableZk: "Ativar conhecimento zero",
	phraseTitle: "Guarde a frase de recuperação da clínica",
	phraseWarning:
		"Esta frase é a única cópia da chave mestra da clínica. Imprima-a ou anote-a e guarde-a em local seguro — se todos os dispositivos aprovados forem perdidos, somente esta frase recupera os registros.",
	phraseConfirm: "Guardei a frase de recuperação em segurança",
	copy: "Copiar",
	copied: "Copiado",
	cancel: "Cancelar",
	devicesTitle: "Dispositivos dos membros",
	devicesEmpty: "Nenhum dispositivo inscrito ainda.",
	colDevice: "Chave do dispositivo",
	colMember: "Membro",
	colStatus: "Status",
	colCreated: "Inscrito em",
	colActions: "Ações",
	thisDevice: "este dispositivo",
	statusPending: "Pendente",
	statusApproved: "Aprovado",
	statusRevoked: "Revogado",
	enrollThisDevice: "Inscrever este dispositivo",
	pendingApproval: "Aguardando a aprovação deste dispositivo por um administrador da clínica.",
	approve: "Aprovar",
	approveTitle: "Aprovar dispositivo",
	approveDescription: (userId) =>
		`Conceder a este dispositivo acesso aos registros criptografados da clínica (membro ${userId})?`,
	revoke: "Revogar",
	revokeTitle: "Revogar dispositivo",
	revokeDescription: (userId) =>
		`Remover o acesso deste dispositivo aos registros criptografados da clínica (membro ${userId})? Os registros existentes continuam criptografados para os demais dispositivos.`,
	restoreTitle: "Restaurar pela frase de recuperação",
	restoreDescription:
		"Digite a frase de recuperação da clínica para ativar a chave mestra neste dispositivo.",
	phrasePlaceholder: "xxxx-xxxx-xxxx-…",
	restore: "Restaurar",
	actionFailed: "A ação falhou — tente novamente.",
	byokTitle: "Chave de LLM para extração (BYOK)",
	byokDescription:
		"Opcional. Com sua própria chave de provedor, a extração da anamnese chama seu provedor de LLM diretamente deste dispositivo — as transcrições nunca passam pelos servidores da KTB. Sem ela, o extrator heurístico local é usado.",
	byokConfigured: "Há uma chave de provedor armazenada neste dispositivo (criptografada).",
	byokNotConfigured:
		"Nenhuma chave de provedor neste dispositivo — o extrator heurístico local é usado.",
	byokModelLabel: "Modelo",
	byokBaseUrlLabel: "URL do endpoint",
	byokApiKeyLabel: "Chave de API do provedor",
	byokSave: "Salvar chave",
	byokClear: "Remover chave",
};

const es: VaultMessages = {
	title: "Bóveda de la clínica",
	description: "Claves de cifrado de conocimiento cero de los registros de esta clínica.",
	personalScope: "Selecciona un espacio de clínica para gestionar sus claves de cifrado.",
	zkOn: "Conocimiento cero activado",
	zkOff: "Conocimiento cero desactivado",
	nonZkTitle: "Los registros de conocimiento cero están desactivados",
	nonZkMember:
		"Esta clínica aún no ha activado los registros de conocimiento cero. Pide a un administrador de la clínica.",
	nonZkAdmin:
		"Activa el cifrado de extremo a extremo de los registros de esta clínica. Es permanente: los registros creados después solo se pueden leer en dispositivos aprobados.",
	enableZk: "Activar conocimiento cero",
	phraseTitle: "Guarda la frase de recuperación de la clínica",
	phraseWarning:
		"Esta frase es la única copia de la clave maestra de la clínica. Imprímela o anótala y guárdala en un lugar seguro: si se pierden todos los dispositivos aprobados, solo esta frase puede recuperar los registros.",
	phraseConfirm: "Guardé la frase de recuperación en un lugar seguro",
	copy: "Copiar",
	copied: "Copiado",
	cancel: "Cancelar",
	devicesTitle: "Dispositivos de los miembros",
	devicesEmpty: "Aún no hay dispositivos inscritos.",
	colDevice: "Clave del dispositivo",
	colMember: "Miembro",
	colStatus: "Estado",
	colCreated: "Inscrito",
	colActions: "Acciones",
	thisDevice: "este dispositivo",
	statusPending: "Pendiente",
	statusApproved: "Aprobado",
	statusRevoked: "Revocado",
	enrollThisDevice: "Inscribir este dispositivo",
	pendingApproval: "Esperando que un administrador de la clínica apruebe este dispositivo.",
	approve: "Aprobar",
	approveTitle: "Aprobar dispositivo",
	approveDescription: (userId) =>
		`¿Conceder a este dispositivo acceso a los registros cifrados de la clínica (miembro ${userId})?`,
	revoke: "Revocar",
	revokeTitle: "Revocar dispositivo",
	revokeDescription: (userId) =>
		`¿Quitar el acceso de este dispositivo a los registros cifrados de la clínica (miembro ${userId})? Los registros existentes siguen cifrados para los demás dispositivos.`,
	restoreTitle: "Restaurar con la frase de recuperación",
	restoreDescription:
		"Introduce la frase de recuperación de la clínica para activar la clave maestra en este dispositivo.",
	phrasePlaceholder: "xxxx-xxxx-xxxx-…",
	restore: "Restaurar",
	actionFailed: "La acción falló — inténtalo de nuevo.",
	byokTitle: "Clave LLM de extracción (BYOK)",
	byokDescription:
		"Opcional. Con tu propia clave de proveedor, la extracción de la anamnesis llama a tu proveedor de LLM directamente desde este dispositivo: las transcripciones nunca pasan por los servidores de KTB. Sin ella, se usa el extractor heurístico local.",
	byokConfigured: "Hay una clave de proveedor almacenada en este dispositivo (cifrada).",
	byokNotConfigured:
		"No hay clave de proveedor en este dispositivo: se usa el extractor heurístico local.",
	byokModelLabel: "Modelo",
	byokBaseUrlLabel: "URL del endpoint",
	byokApiKeyLabel: "Clave de API del proveedor",
	byokSave: "Guardar clave",
	byokClear: "Eliminar clave",
};

const catalogs: Record<VaultLocale, VaultMessages> = { en, "pt-BR": ptBR, es };

export const vaultMessages = (locale?: string): VaultMessages =>
	catalogs[isVaultLocale(locale ?? "") ? (locale as VaultLocale) : BASE_LOCALE];
