export interface AiPromptMessages {
	readonly title: string;
	readonly subtitle: string;
	readonly add: string;
	readonly newVersion: string;
	readonly edit: string;
	readonly empty: string;
	readonly name: string;
	readonly version: string;
	readonly locale: string;
	readonly template: string;
	readonly variables: string;
	readonly modelHint: string;
	readonly isSystem: string;
	readonly isDefault: string;
	readonly enabled: string;
	readonly save: string;
	readonly cancel: string;
	readonly delete: string;
	readonly confirmDelete: string;
	readonly actionFailed: string;
	readonly templateHint: string;
}

const en: AiPromptMessages = {
	title: "AI prompts",
	subtitle: "Versioned prompt registry — resolve pins name@version for reproducibility.",
	add: "Add prompt",
	newVersion: "New version",
	edit: "Edit",
	empty: "No prompts yet — seed the first registry entry.",
	name: "Name",
	version: "Version",
	locale: "Locale",
	template: "Template",
	variables: "Variables",
	modelHint: "Model hint",
	isSystem: "System prompt",
	isDefault: "Default",
	enabled: "Enabled",
	save: "Save",
	cancel: "Cancel",
	delete: "Delete",
	confirmDelete: "Delete this prompt version? Consumers pinned to it will resolve null.",
	actionFailed: "Action failed — check permissions and try again.",
	templateHint: "Template text — declare variables as {name} placeholders.",
};

const ptBR: AiPromptMessages = {
	title: "Prompts de IA",
	subtitle: "Registro versionado de prompts — resolver fixa name@version para reprodutibilidade.",
	add: "Adicionar prompt",
	newVersion: "Nova versão",
	edit: "Editar",
	empty: "Nenhum prompt ainda — semeie a primeira entrada do registro.",
	name: "Nome",
	version: "Versão",
	locale: "Locale",
	template: "Template",
	variables: "Variáveis",
	modelHint: "Dica de modelo",
	isSystem: "Prompt de sistema",
	isDefault: "Padrão",
	enabled: "Ativo",
	save: "Guardar",
	cancel: "Cancelar",
	delete: "Eliminar",
	confirmDelete: "Eliminar esta versão do prompt? Consumidores fixados nela resolverão null.",
	actionFailed: "A ação falhou — verifique permissões e tente de novo.",
	templateHint: "Texto do template — declare variáveis como placeholders {name}.",
};

const es: AiPromptMessages = {
	title: "Prompts de IA",
	subtitle: "Registro versionado de prompts — resolver fija name@version para reproducibilidad.",
	add: "Añadir prompt",
	newVersion: "Nueva versión",
	edit: "Editar",
	empty: "Sin prompts aún — siembra la primera entrada del registro.",
	name: "Nombre",
	version: "Versión",
	locale: "Locale",
	template: "Template",
	variables: "Variables",
	modelHint: "Pista de modelo",
	isSystem: "Prompt de sistema",
	isDefault: "Predeterminado",
	enabled: "Activo",
	save: "Guardar",
	cancel: "Cancelar",
	delete: "Eliminar",
	confirmDelete:
		"¿Eliminar esta versión del prompt? Los consumidores fijados a ella resolverán null.",
	actionFailed: "La acción falló — revisa permisos e intenta de nuevo.",
	templateHint: "Texto del template — declara variables como placeholders {name}.",
};

export const aiPromptMessages = (locale: string): AiPromptMessages =>
	locale.startsWith("pt") ? ptBR : locale.startsWith("es") ? es : en;
