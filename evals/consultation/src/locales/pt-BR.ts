import type { AnamnesisContent, LocaleProfile, ScriptContent } from "../locale.ts";

/**
 * pt-BR locale profile — the default `LocaleProfile` for the eval
 * core. All pt-BR-specific behavior lives here: numeral words,
 * speaker labels, decimal separator, PHI patterns (CPF/BR phone/DOB
 * phrasing), the ASR language hint, and the consultation slot
 * tables. metrics/anonymize/scriptgen/pipeline consume it through
 * the `LocaleProfile` interface — nothing here is imported by name
 * outside this file except via the profile object.
 */

// ---------- number words (0–9999) ----------

const UNITS = [
	"zero",
	"um",
	"dois",
	"três",
	"quatro",
	"cinco",
	"seis",
	"sete",
	"oito",
	"nove",
	"dez",
	"onze",
	"doze",
	"treze",
	"quatorze",
	"quinze",
	"dezesseis",
	"dezessete",
	"dezoito",
	"dezenove",
];
const TENS = [
	"",
	"",
	"vinte",
	"trinta",
	"quarenta",
	"cinquenta",
	"sessenta",
	"setenta",
	"oitenta",
	"noventa",
];
const HUNDREDS = [
	"",
	"cento",
	"duzentos",
	"trezentos",
	"quatrocentos",
	"quinhentos",
	"seiscentos",
	"setecentos",
	"oitocentos",
	"novecentos",
];

/** pt-BR number words 0–9999 — "50"→"cinquenta" (a dose), never
 * "cinco zero". Approximation is fine: ref and hyp normalize the
 * same way. */
const numberToWords = (n: number): string => {
	if (n < 20) return UNITS[n]!;
	if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` e ${UNITS[n % 10]}` : "");
	if (n === 100) return "cem";
	if (n < 1000) {
		const rest = n % 100;
		return HUNDREDS[Math.floor(n / 100)]! + (rest ? ` e ${numberToWords(rest)}` : "");
	}
	if (n < 10000) {
		const rest = n % 1000;
		const head = n === 1000 ? "mil" : `${numberToWords(Math.floor(n / 1000))} mil`;
		return head + (rest ? ` ${rest < 100 ? "e " : ""}${numberToWords(rest)}` : "");
	}
	return String(n);
};

// ---------- PHI patterns (moved verbatim from anonymize.ts) ----------

const PII_PATTERNS: LocaleProfile["piiPatterns"] = [
	// CPF: 123.456.789-00 or 12345678900 (word-bounded).
	{
		category: "cpf",
		re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
		token: "[CPF]",
	},
	// BR phones: (11) 91234-5678 | 11 91234-5678 | 9+8-digit runs.
	{
		category: "phone",
		re: /\b(?:\(?\d{2}\)?\s?)?9?\d{4}-?\d{4}\b/g,
		token: "[PHONE]",
	},
	{ category: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, token: "[EMAIL]" },
	// Date of birth phrasing — "nascido em 12/03/1985", "DN: 12-03-1985".
	{
		category: "date_of_birth",
		re: /\b(?:nascid[ao](?:\sem)?|data de nascimento[:\s]?|DN[:\s])\s*\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/gi,
		token: "[DOB]",
	},
];

// ---------- script slot tables (moved verbatim from scriptgen.ts) ----------

const SCRIPT: ScriptContent = {
	greeting: {
		formal: ["Bom dia. Sou o médico responsável pelo seu atendimento. Em que posso ajudar?"],
		colloquial: [
			"Oi, bom dia! Me conta o que tá acontecendo.",
			"Bom dia! Como posso te ajudar hoje?",
		],
	},

	chiefComplaint: {
		general_practice: {
			formal: ["Refiro cefaleia intensa há três dias, sem melhora com repouso."],
			colloquial: ["Tô com uma dor de cabeça muito forte faz uns três dias."],
		},
		pediatrics: {
			formal: ["A criança apresenta febre e recusa alimentar desde ontem."],
			colloquial: ["Minha filha tá com febre e não quer comer nada desde ontem."],
		},
		gynecology: {
			formal: ["Apresento cólicas intensas e alteração do ciclo menstrual."],
			colloquial: ["Tô com cólica muito forte e minha menstruação tá desregulada."],
		},
		geriatrics: {
			formal: ["Refiro tonturas frequentes ao levantar, há duas semanas."],
			colloquial: ["Tô ficando tonto toda vez que eu levanto, já tem umas duas semanas."],
		},
		cardiology: {
			formal: ["Refiro dor precordial aos esforços e dispneia associada."],
			colloquial: ["Sinto um aperto no peito quando ando e fico sem fôlego."],
		},
		psychiatry: {
			formal: ["Refiro insônia persistente e episódios de ansiedade."],
			colloquial: ["Não tô conseguindo dormir direito e ando muito ansioso."],
		},
	},

	allergyQuestion: {
		formal: ["O senhor possui alergia conhecida a algum medicamento?"],
		colloquial: ["Você tem alergia a algum remédio?"],
	},

	// Denial variants paired with their negation marker — the gold
	// entity is the MARKER, not the utterance: losing "não"/"nega" is the
	// dangerous event, and substring alignment stays robust to ASR word
	// errors elsewhere in the phrase.
	allergyDeny: [
		{ marker: "não tenho alergia", text: "não tenho alergia a remédio nenhum" },
		{ marker: "nega alergia", text: "nega alergia a medicamentos" },
	],

	allergyAffirm: [
		{ med: "penicilina", text: "sou alérgico a penicilina" },
		{ med: "dipirona", text: "sou alérgico a dipirona" },
	],

	prescriptions: {
		general_practice: [
			{ med: "dipirona", dose: "500 mg", freq: "de 8 em 8 horas" },
			{ med: "losartana", dose: "50 mg", freq: "uma vez ao dia" },
		],
		pediatrics: [
			{ med: "dipirona em gotas", dose: "20 gotas", freq: "de 6 em 6 horas" },
			{ med: "amoxicilina em suspensão", dose: "5 ml", freq: "de 8 em 8 horas" },
		],
		gynecology: [
			{ med: "ácido fólico", dose: "5 mg", freq: "uma vez ao dia" },
			{ med: "ibuprofeno", dose: "400 mg", freq: "de 8 em 8 horas" },
		],
		geriatrics: [
			{ med: "losartana", dose: "50 mg", freq: "uma vez ao dia" },
			{ med: "sinvastatina", dose: "20 mg", freq: "à noite" },
		],
		cardiology: [
			{ med: "atenolol", dose: "25 mg", freq: "uma vez ao dia" },
			{ med: "losartana", dose: "50 mg", freq: "uma vez ao dia" },
		],
		psychiatry: [
			{ med: "sertralina", dose: "50 mg", freq: "uma vez ao dia" },
			{ med: "lorazepam", dose: "1 mg", freq: "à noite" },
		],
	},

	prescriptionText: {
		formal: (p) => `Prescrevo ${p.med} ${p.dose}, ${p.freq}.`,
		colloquial: (p) => `Vou te passar ${p.med} ${p.dose}, você toma ${p.freq}, tá bom?`,
	},

	closing: {
		formal: ["Retorne em quinze dias para reavaliação."],
		colloquial: ["Volta aqui em umas duas semanas pra gente ver como você tá, tá certo?"],
	},

	regionMarker: {
		southeast: "uai",
		south: "tchê",
		northeast: "oxente",
		north: "massa",
		central_west: "meu",
	},
	fallbackRegionMarker: "uai",
};

// ---------- long-form anamnesis ----------

const ANAMNESIS: AnamnesisContent = {
	beats: [
		// abertura + identificação
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Bom dia, ${d.patientTag}. Sou o médico responsável pelo seu atendimento. Pode se acomodar. Como posso ajudar hoje?`
						: `Bom dia, ${d.patientTag}! Pode sentar, fica à vontade. Me conta o que te trouxe aqui hoje?`,
				(d, r) =>
					r === "formal"
						? `Bom dia, ${d.patientTag}. Seja bem-vindo. Sou o médico de plantão e vou acompanhar o senhor hoje. O que o traz ao consultório?`
						: `Bom dia, ${d.patientTag}! Sou o médico que vai te atender hoje. O que tá pegando?`,
			],
		},
		{ speaker: "patient", variants: [(d) => d.complaint] },
		// HDA — início, localização, caráter, intensidade
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Entendo. Me conta um pouco mais: quando exatamente isso começou?`
						: `Saquei. E isso começou quando, mais ou menos?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Começou ${d.onset}. No início achei que ia passar sozinho, mas só piorou.`
						: `Ah, começou ${d.onset}. Achei que ia melhorar, mas foi só piorando.`,
				(d, r) =>
					r === "formal"
						? `Os sintomas surgiram ${d.onset}, de forma gradual.`
						: `Foi ${d.onset} que começou, aos pouquinhos.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Certo. E como o senhor descreveria essa dor? É uma dor em peso, em pontada, em queimação?`
						: `E essa dor é como? Tipo um peso, uma pontada, uma queimação?`,
			],
		},
		{ speaker: "patient", variants: [(d) => d.hpiDetail] },
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Numa escala de zero a dez, em que zero é ausência de dor e dez é a pior dor da sua vida, que nota o senhor daria?`
						: `De zero a dez, quanto tá essa dor agora? Zero é nada e dez é insuportável.`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Eu diria uns ${d.intensity}. Às vezes piora um pouco.`
						: `Ah, acho que uns ${d.intensity}. Tem hora que aperta mais.`,
				(d, r) =>
					r === "formal"
						? `Por volta de ${d.intensity}, senhor. De noite fica pior.`
						: `Uns ${d.intensity} mais ou menos. De noite aperta mais.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E tem alguma coisa que piora? Movimento, esforço, algum alimento, alguma posição?`
						: `O que faz piorar? Mexer, andar, comer alguma coisa?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Piora bastante quando faço esforço ou me movimento. Repouso ajuda um pouco, mas não resolve.`
						: `Piora quando eu faço força ou me mexo muito. Descansar até ajuda, mas não passa.`,
				(d, r) =>
					r === "formal"
						? `O esforço físico definitivamente agrava. Até subir escada já piora.`
						: `Quando eu faço esforço piora bastante. Até subir escada já fica ruim.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E junto com isso, o senhor sente mais alguma coisa? Febre, enjoo, tontura, falta de ar?`
						: `E além disso, sente mais alguma coisa junto? Febre, ânsia, tontura?`,
			],
		},
		{ speaker: "patient", variants: [(d) => d.associated] },
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `O senhor já teve um episódio parecido antes, ou é a primeira vez?`
						: `Já teve isso antes ou é a primeira vez?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Já tive episódios parecidos antes, mas nunca tão forte nem durando tanto.`
						: `Já tive parecido, mas nunca tão forte assim, nem durando tanto.`,
				(d, r) =>
					r === "formal"
						? `É a primeira vez que sinto isso com essa intensidade.`
						: `Primeira vez que sinto isso desse jeito.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `O senhor fez alguma coisa diferente esses dias? Viagem, mudança de rotina, alimentação diferente?`
						: `Fez algo diferente esses dias? Viajou, mudou rotina, comeu diferente?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Não, senhor. A rotina foi a mesma de sempre. Só andei dormindo pior essa semana.`
						: `Nada diferente não. Só andei dormindo mal essa semana.`,
				(d, r) =>
					r === "formal"
						? `Na verdade trabalhei bastante esses dias, muito tempo sentado e pouca pausa.`
						: `Ah, trabalhei bastante esses dias, muito tempo sentado, sem pausa.`,
			],
		},
		// revisão de sistemas
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Vou fazer umas perguntas rápidas de revisão geral. Perda de peso sem explicação?`
						: `Rapidinho: perdeu peso sem querer esses tempos?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) => (r === "formal" ? `Não, senhor. Peso estável.` : `Não, peso tá o mesmo.`),
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E evacuações e urina, tudo normal?`
						: `E o banheiro, tá tudo normal? Xixi e cocô?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) => (r === "formal" ? `Tudo normal, sem queixas.` : `Tá tudo certo, sem problema.`),
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E visão? Alguma alteração visual, luzes, manchas?`
						: `E a vista, tá boa? Não vê luzinha, mancha, nada?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal" ? `Não, senhor. A visão está normal.` : `Não, tá tudo normal com a vista.`,
				(d, r) =>
					r === "formal"
						? `Só uma vista um pouco cansada no fim do dia, nada além disso.`
						: `Só a vista meio cansada no fim do dia, mas nada de mais.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Sente algum zumbido no ouvido ou alteração de audição?`
						: `Sente zumbido ou tá ouvindo menos?`,
			],
		},
		{
			speaker: "patient",
			variants: [(d, r) => (r === "formal" ? `Não, senhor. Nada disso.` : `Não, tá tudo normal.`)],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E respirando, sente alguma dificuldade? Tosse, chiado?`
						: `E de respirar, tá tranquilo? Tosse, chiado?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal" ? `Respiração normal, sem tosse.` : `Tá normal, sem tosse nenhuma.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E o coração? Já sentiu palpitação, dor no peito, falta de ar ao deitar?`
						: `E o coração? Já sentiu ele disparar, dor no peito, ou falta de ar deitado?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Não, senhor. Nunca senti nada disso.`
						: `Não, graças a Deus nunca senti.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E pele? Manchas, coceira, feridas que demoram pra sarar?`
						: `E a pele? Mancha, coceira, ferida que não sara?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) => (r === "formal" ? `Não, senhor. Pele normal.` : `Nada disso não, pele tá boa.`),
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E articulações? Dor ou inchaço nas juntas?`
						: `E as juntas? Doem ou incham?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Às vezes um incômodo no joelho, mas nada grave.`
						: `Só uma dorzinha no joelho de vez em quando, nada demais.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E dormindo, o senhor ronca? Já disseram que para de respirar?`
						: `E dormindo, ronca? Alguém já falou que para de respirar?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Minha esposa diz que ronco, mas nada de parar de respirar.`
						: `Dizem que eu ronco bastante, mas parar de respirar nunca ouvi.`,
				(d, r) => (r === "formal" ? `Não que eu saiba, senhor.` : `Que eu saiba não, não.`),
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E o intestino, funciona bem? E a urina, alguma ardência ou mudança?`
						: `E o intestino, tá funcionando? E xixi, arde ou mudou?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Intestino funciona normal, uma vez ao dia. Urina normal, sem dor.`
						: `Tá tudo normal, intestino direitinho e xixi sem dor.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Certo, obrigado pelas respostas. Isso me ajuda a montar o quadro completo. Agora vou fazer mais umas perguntas sobre a sua saúde em geral, pode ser?`
						: `Beleza, anotado. Isso me ajuda bastante. Agora deixa eu perguntar mais umas coisas da sua saúde, rapidinho.`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) => (r === "formal" ? `Claro, doutor. Pode perguntar.` : `Pode sim, doutor.`),
			],
		},
		// antecedentes pessoais
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Vamos falar da sua saúde em geral. O senhor tem alguma doença de base? Pressão alta, diabetes, problemas de coração?`
						: `Agora me conta da sua saúde: tem pressão alta, diabetes, algum problema de coração?`,
			],
		},
		{ speaker: "patient", variants: [(d) => d.comorbidities] },
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E o senhor usa algum medicamento de forma contínua? Remédios de uso diário?`
						: `E toma remédio todo dia? Tem algum de uso contínuo?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					d.currentMeds.length === 0
						? r === "formal"
							? `Não, senhor. Não uso nenhum medicamento de forma contínua.`
							: `Não, não tomo nada de uso contínuo não.`
						: r === "formal"
							? `Sim. Eu uso ${d.currentMeds.map((m) => `${m.med} ${m.dose}, ${m.freq}`).join("; e também ")}.`
							: `Uso sim: ${d.currentMeds.map((m) => `${m.med} ${m.dose}, ${m.freq}`).join("; e também ")}.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					d.currentMeds.length > 0
						? r === "formal"
							? `O senhor toma direitinho, nos horários certos, ou acaba esquecendo às vezes?`
							: `E toma certinho todo dia ou acaba esquecendo?`
						: r === "formal"
							? `Entendo. E vitaminas, fitoterápicos, algum remédio por conta própria?`
							: `E não toma nada por conta própria? Nem vitamina, chá, nada?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					d.currentMeds.length > 0
						? r === "formal"
							? `Confesso que às vezes esqueço a dose da noite, mas no geral tomo direito.`
							: `Ah, de vez em quando eu esqueço a da noite, mas no geral tomo direitinho.`
						: r === "formal"
							? `Não, senhor. De vez em quando tomo um analgésico para dor de cabeça, só isso.`
							: `Não, só um remedinho pra dor de cabeça de vez em quando.`,
			],
		},
		// alergias (slot existente — mantém gold de negação/medicação)
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `O senhor possui alergia conhecida a algum medicamento, alimento ou substância?`
						: `Você tem alergia a algum remédio, comida, qualquer coisa?`,
			],
		},
		{ speaker: "patient", variants: [(d) => d.allergyAnswer] },
		// história familiar
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E na sua família? Alguém tem doença importante — coração, diabetes, câncer?`
						: `E na família, alguém tem alguma doença séria? Coração, diabetes, câncer?`,
			],
		},
		{ speaker: "patient", variants: [(d) => d.familyHx] },
		// hábitos de vida
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `O senhor fuma ou já fumou? E bebida alcoólica, consome com que frequência?`
						: `Você fuma? E de bebida, bebe bastante?`,
			],
		},
		{ speaker: "patient", variants: [(d) => d.habits] },
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E como está a alimentação? Come bastante fruta, verdura, ou mais processados?`
						: `E de comida, como tá a dieta? Fruta, verdura, ou mais besteira?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Procuro comer bem, mas confesso que no dia a dia acabo comendo muito rápido e comida pronta.`
						: `Ah, tento comer direito, mas no corre do dia acabo comendo qualquer coisa.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E atividade física, faz alguma coisa? Caminhada, academia, algum esporte?`
						: `E exercício, faz alguma coisa? Caminhada, academia?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Muito pouco, senhor. Queria caminhar, mas falta tempo e ânimo.`
						: `Quase nada, viu. Queria caminhar mas sempre falta tempo.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E o que o senhor faz da vida? Trabalha com o quê? Como anda o sono?`
						: `E trabalha com o quê? Tá dormindo bem?`,
			],
		},
		{ speaker: "patient", variants: [(d) => d.occupation] },
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E o senhor consegue descansar bem à noite? Quantas horas dorme por noite, em média?`
						: `E consegue dormir bem? Quantas horas por noite, mais ou menos?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Durmo umas seis horas, mas acordo duas ou três vezes por noite.`
						: `Umas seis horas, mas acordo direto no meio da noite.`,
				(d, r) =>
					r === "formal" ? `Umas sete horas, sono tranquilo.` : `Sete horinhas, durmo bem.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal" ? `E cafeína? Café, chá, energético?` : `E café? Toma muito? Energético?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Café todo dia, umas três xícaras. Energético não tomo.`
						: `Café eu tomo, umas três xícaras por dia. Energético não.`,
				(d, r) =>
					r === "formal" ? `Só um café de manhã, mais nada.` : `Só um cafezinho de manhã.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E como anda o estresse no trabalho e em casa? Algum período mais difícil recentemente?`
						: `E o estresse? Tá passando por alguma fase difícil?`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `O trabalho anda puxado, muita cobrança. Em casa está tudo bem.`
						: `No trabalho tá apertado, muita cobrança. Em casa tá tranquilo.`,
				(d, r) =>
					r === "formal"
						? `Um pouco de preocupação com as contas, mas nada fora do normal.`
						: `Aquela preocupação de conta pra pagar, mas nada demais.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Entendo. O estresse pode sim piorar os sintomas. Vou anotar isso.`
						: `Pois é, o estresse piora tudo mesmo. Vou anotar aqui.`,
			],
		},
		// exame físico — médico narra
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Agora vou examinar o senhor. Pode deitar aqui na maca, por favor.`
						: `Deixa eu te examinar agora. Deita aqui na maca pra mim.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d) =>
					`Pressão arterial ${d.vitals.pa}, frequência cardíaca ${d.vitals.fc} batimentos por minuto, frequência respiratória ${d.vitals.fr} movimentos, temperatura ${d.vitals.temp} graus, saturação de oxigênio ${d.vitals.sat} por cento em ar ambiente.`,
			],
		},
		{ speaker: "doctor", variants: [(d) => d.examFindings] },
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Abdome plano, ruidos hidroaéreos presentes e normais, indolor à palpação superficial e profunda. Extremidades sem edema, pulsos periféricos simétricos.`
						: `Barriga normal, sem dor nenhuma quando eu aperto. Pernas sem inchaço, pulsos todos iguais dos dois lados.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Pode sentar. Pronto, terminei o exame. Pode voltar para a cadeira.`
						: `Pode sentar agora, pronto. Volta pra cadeira.`,
			],
		},
		// hipótese + explicação
		{ speaker: "doctor", variants: [(d) => d.hypothesis] },
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Entendo, doutor. E é grave? Preciso me preocupar?`
						: `Ah tá. Mas é grave isso, doutor?`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Não se assuste. Com o tratamento correto a evolução costuma ser boa. Vou explicar o que vamos fazer.`
						: `Calma, não é nada grave. Fazendo o tratamento direitinho melhora sim. Deixa eu te explicar.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Veja bem: o nosso corpo dá sinais quando algo está fora do lugar, e o seu quadro, pelo que o senhor me contou e pelo exame, se encaixa num padrão bastante conhecido na clínica. A gente trata a causa, alivia os sintomas e acompanha a evolução de perto.`
						: `Olha, o corpo dá sinais quando algo tá errado, e o seu caso, pelo que você contou e pelo exame, é bem típico. A gente trata a causa, alivia os sintomas e vai acompanhando de perto.`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Entendi. E precisa de exame, doutor? Tomografia, ressonância, essas coisas?`
						: `Entendi. E precisa fazer exame, doutor? Tipo tomografia?`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Por enquanto não é necessário. Se o tratamento não resolver ou se surgir algum sinal de alarme, aí sim a gente investiga com imagem. Pedir exame sem indicação só gera custo e ansiedade.`
						: `Por agora não precisa. Se não melhorar com o tratamento, ou se surgir algo diferente, aí a gente pede. Exame sem necessidade só dá despesa e preocupação.`,
			],
		},
		// prescrição detalhada
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Vou prescrever ${d.rx.med} ${d.rx.dose}, ${d.rx.freq}, por sete dias. Tome sempre junto com uma refeição para proteger o estômago.`
						: `Vou te passar ${d.rx.med} ${d.rx.dose}, você toma ${d.rx.freq} durante uma semana. Toma junto com a comida pra não dar dor de estômago.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					d.rx2 !== undefined
						? r === "formal"
							? `Além disso, para o alívio dos sintomas, ${d.rx2.med} ${d.rx2.dose}, ${d.rx2.freq}, somente se necessário.`
							: `E pra aliviar, ${d.rx2.med} ${d.rx2.dose}, ${d.rx2.freq}, só quando precisar.`
						: r === "formal"
							? `Não interrompa o tratamento antes do prazo, mesmo que melhore antes.`
							: `E não para de tomar antes da hora, tá? Mesmo que melhore, termina os sete dias.`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `E eu posso continuar trabalhando normalmente, doutor?`
						: `Posso continuar trabalhando normal, doutor?`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Pode sim, apenas evite esforços excessivos nos próximos dias. Repouso relativo.`
						: `Pode sim, só evita esforço muito pesado esses dias. Pega leve.`,
			],
		},
		// orientações não-farmacológicas
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Recomendo também hidratação adequada, pelo menos dois litros de água por dia, e alimentação leve.`
						: `Ah, e bebe bastante água, uns dois litros por dia, e come leve.`,
				(d, r) =>
					r === "formal"
						? `Evite gorduras e condimentos fortes nos próximos dias. Prefira alimentos de fácil digestão.`
						: `Evita comida muito gordurosa e tempero forte. Come coisas mais leves.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E vou anotar tudo na receita: o nome do remédio, a dose, os horários e até quando tomar. Qualquer dúvida na farmácia, é só mostrar a receita.`
						: `E eu vou escrever tudo certinho na receita: nome, dose, horário, até quando. Na farmácia é só mostrar.`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Perfeito. E se eu esquecer uma dose, o que eu faço?`
						: `E se eu esquecer de tomar uma vez, o que faço?`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Se esquecer uma dose, tome assim que lembrar, mas nunca dobre a dose seguinte para compensar. Se faltar pouco para o próximo horário, pule a esquecida e siga o esquema normal.`
						: `Se esquecer, toma assim que lembrar, mas nunca toma dose dobrada. Se já tá perto da próxima, pula aquela e segue normal.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Atenção aos sinais de alarme: se aparecer febre alta, piora súbita da dor, vômitos que não param, ou qualquer sintoma novo, procure o pronto-socorro imediatamente, não espere o retorno.`
						: `Presta atenção: se der febre alta, a dor piorar de repente, ou vomitar sem parar, vai direto pro pronto-socorro, não espera o retorno não.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `E qualquer outra dúvida, o senhor pode voltar aqui ou mandar mensagem para a clínica. Não guarde dúvida para casa.`
						: `E qualquer dúvida é só voltar aqui ou mandar mensagem pra clínica, tá? Não fica com dúvida não.`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Entendi, doutor. Agradeço muito a atenção e o cuidado.`
						: `Entendi tudo direitinho. Obrigado mesmo pela paciência, doutor.`,
			],
		},
		{
			speaker: "patient",
			variants: [
				(d, r) =>
					r === "formal"
						? `Entendi, doutor. Muito obrigado pela atenção.`
						: `Tá bom, doutor, muito obrigado mesmo.`,
			],
		},
		{
			speaker: "doctor",
			variants: [
				(d, r) =>
					r === "formal"
						? `Retorne em quinze dias para reavaliação. Se piorar antes, não espere — volte ou procure o pronto atendimento. Tenha um bom dia.`
						: `Volta aqui em umas duas semanas pra gente ver como você tá. Se piorar antes, volta antes, tá? Tchau, se cuida!`,
			],
		},
	],

	hpiDetail: {
		general_practice: {
			formal: [
				`É uma dor pulsátil, mais forte na testa e nas têmporas, que irradia para a nuca.`,
				`É uma dor em peso, contínua, que aperta a cabeça inteira como um capacete.`,
			],
			colloquial: [
				`É uma dor que fica pulsando aqui na testa, e desce até a nuca.`,
				`É um peso na cabeça inteira, parece que aperta dos dois lados.`,
			],
		},
		pediatrics: {
			formal: [
				`A febre é alta, medida em trinta e oito e meio, e a criança está prostrada, sem apetite.`,
			],
			colloquial: [
				`A febre tá alta, deu trinta e oito e meio, e ela tá só caída, sem querer comer.`,
			],
		},
		gynecology: {
			formal: [
				`É uma cólica intensa, em ondas, que irradia para a região lombar, acompanhada de fluxo aumentado.`,
			],
			colloquial: [`É uma cólica que vem em ondas, bem forte, e pega a lombar toda.`],
		},
		geriatrics: {
			formal: [`É uma tontura rotatória, principalmente ao me levantar da cama ou de uma cadeira.`],
			colloquial: [`É um negócio que roda tudo, principalmente quando eu levanto da cama.`],
		},
		cardiology: {
			formal: [
				`É uma dor em aperto no centro do peito, que irradia para o braço esquerdo e piora aos esforços.`,
			],
			colloquial: [`É um aperto aqui no peito, que pega o braço esquerdo, e piora quando eu ando.`],
		},
		psychiatry: {
			formal: [
				`É uma sensação de aperto no peito com pensamentos acelerados, principalmente à noite.`,
			],
			colloquial: [
				`É um aperto aqui no peito e a cabeça não para de pensar, principalmente de noite.`,
			],
		},
	},

	associated: {
		general_practice: [
			`Às vezes sinto um pouco de náusea e fotofobia, mas sem febre.`,
			`Sinto um enjoo leve e incomodo com luz forte. Sem febre.`,
		],
		pediatrics: [`Ela também está com coriza e um pouco de tosse seca.`],
		gynecology: [`Sinto também enjoo matinal e muita fraqueza nos dias de cólica.`],
		geriatrics: [`Às vezes escurece a visão e já quase caí duas vezes.`],
		cardiology: [`Sinto falta de ar junto e um suor frio quando a dor aperta.`],
		psychiatry: [`Acordo várias vezes de madrugada com o coração disparado.`],
	},

	examFindings: {
		general_practice: [
			`Paciente consciente, orientada, hidratada. Sem sinais de alteração ao exame neurológico de triagem. Ausculta cardíaca e pulmonar sem alterações. Abdome indolor à palpação.`,
			`Paciente em bom estado geral, corada e hidratada. Exame neurológico e cardiorrespiratório sem alterações significativas.`,
		],
		pediatrics: [
			`Criança febril, irritada, orofaringe hiperemiada com exsudato em amígdalas. Ausculta pulmonar limpa.`,
		],
		gynecology: [
			`Abdome com dor à palpação em fossas ilíacas, sem defesa. Toque especular adiado para o retorno.`,
		],
		geriatrics: [
			`Paciente com discreta instabilidade à marcha. Prova de Romberg discreta e positiva. Sopro carotídeo ausente bilateralmente.`,
		],
		cardiology: [
			`Paciente corado, eupneico em repouso. Ausculta cardíaca em dois tempos, bulhas rítmicas e normofonéticas, sem sopros. Aparelho respiratório com murmúrio vesicular presente.`,
		],
		psychiatry: [
			`Paciente ansioso, verbalização rápida mas organizada. Sem sinais de alteração física ao exame.`,
		],
	},

	hypothesis: {
		general_practice: [
			`Pelo quadro clínico, me parece uma cefaleia do tipo tensional, possivelmente associada a estresse e má postura. Vamos afastar causas mais sérias com o exame e o tratamento.`,
			`O quadro sugere enxaqueca sem aura. O padrão de dor, a fotofobia e a duração são típicos.`,
		],
		pediatrics: [
			`O quadro sugere uma amigdalite viral ou bacteriana em fase inicial. Vamos tratar os sintomas e observar a evolução.`,
		],
		gynecology: [
			`Pelo relato, provavelmente dismenorreia primária associada a ciclo irregular. Vamos investigar com exame de imagem se persistir.`,
		],
		geriatrics: [
			`Pelo quadro, suspeito de hipotensão ortostática, possivelmente relacionada às medicações em uso.`,
		],
		cardiology: [
			`O quadro sugere angina estável, mas precisamos descartar evento coronariano agudo com exames complementares.`,
		],
		psychiatry: [
			`Pelo relato, provavelmente transtorno de ansiedade com insônia associada. Vamos iniciar tratamento e acompanhamento.`,
		],
	},

	onsets: [
		"há três dias",
		"há quase uma semana",
		"há uns cinco dias",
		"faz umas duas semanas",
		"desde segunda-feira passada",
	],

	comorbidSets: [
		[
			"Não, senhor. Graças a Deus não tenho nenhuma doença de base.",
			"Sou saudável, nunca tive nada de sério.",
		],
		["Tenho pressão alta há uns cinco anos.", "Faço acompanhamento de hipertensão arterial."],
		["Tenho diabetes tipo dois e colesterol alto.", "Sou diabético e tenho o colesterol alterado."],
		[
			"Tenho hipotireoidismo e pressão alta.",
			"Faço tratamento para hipotireoidismo e hipertensão.",
		],
	],

	medPool: [
		{ med: "losartana", dose: "50 mg", freq: "uma vez ao dia" },
		{ med: "metformina", dose: "850 mg", freq: "duas vezes ao dia" },
		{ med: "levotiroxina", dose: "50 mcg", freq: "em jejum" },
		{ med: "sinvastatina", dose: "20 mg", freq: "à noite" },
		{ med: "omeprazol", dose: "20 mg", freq: "em jejum" },
		{ med: "anlodipino", dose: "5 mg", freq: "uma vez ao dia" },
		{ med: "hidroclorotiazida", dose: "25 mg", freq: "uma vez ao dia" },
		{ med: "ácido acetilsalicílico", dose: "100 mg", freq: "uma vez ao dia" },
	],

	familyHx: [
		"Meu pai era hipertenso e minha mãe tem diabetes.",
		"Tenho histórico de infarto na família, meu avô faleceu aos cinquenta e oito.",
		"Não, senhor. Família toda saudável, que eu saiba.",
		"Minha mãe tem hipotireoidismo e meu pai era cardíaco.",
	],

	habits: [
		"Não fumo, nunca fumei. Bebo uma cerveja de vez em quando, fim de semana.",
		"Fumei por uns dez anos, parei faz cinco. Bebo raramente.",
		"Fumo sim, uns dez cigarros por dia. Bebida só socialmente.",
		"Não fumo não. Bebo uma taça de vinho de vez em quando.",
	],

	occupations: [
		"Trabalho como professor numa escola pública, muito estresse ultimamente. O sono anda ruim, durmo umas cinco horas por noite.",
		"Trabalho em obra, é pesado fisicamente. Durmo razoavelmente, umas seis horas.",
		"Sou dona de casa e cuido dos netos. Durmo mal, acordo muito de madrugada.",
		"Trabalho sentado em escritório o dia todo. O sono tá péssimo, não consigo desligar a cabeça.",
		"Sou motorista de aplicativo, rodo bastante. Durmo umas seis horas mas descanso pouco.",
	],

	patientQuestions: ["Entendo, doutor. E é grave? Preciso me preocupar?"],

	patientTags: ["paciente um", "paciente dois", "paciente três"],
};

/** The default profile — normalization id "ptbr-v1" is what
 * StageMetrics.normalization persists; keep it stable. */
export const ptBR: LocaleProfile = {
	id: "ptbr-v1",
	asrLanguage: "pt",
	numberToWords,
	// Case-insensitive + tolerant of "Dr."-style abbreviations; runs
	// after lowercasing in normalize but must also work when callers
	// disable `lowercase`.
	speakerLabelRe: /\b(doctor|patient|médico|medico|paciente|doutor|doutora|dr|dra)\.?\s*:/gi,
	decimalWord: "virgula",
	piiPatterns: PII_PATTERNS,
	// Residual long digit runs — likely an id/document (see
	// gateTranscript in anonymize.ts).
	residualIdRe: /\b\d{8,}\b/,
	script: { ...SCRIPT, anamnesis: ANAMNESIS },
};
