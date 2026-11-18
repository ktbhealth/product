import type { PtbrConsult } from "./types.ts";

/**
 * Clínica geral (general_practice) — 3 authored consults.
 * Colloquial and formal registers, adult + elderly patients, chronic
 * complaints managed in primary care. Noise: fillers, false starts,
 * spoken doses/frequencies, negated allergies.
 */
export const GENERAL_PRACTICE: readonly PtbrConsult[] = [
	{
		slug: "gp-cefaleia-01",
		specialty: "general_practice",
		region: "southeast",
		ageBand: "adult",
		register: "colloquial",
		gender: "f",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Helena",
		doctor: { gender: "f", register: "formal" },
		turns: [
			{
				speaker: "doctor",
				text: "Boa tarde, dona Helena, tudo bem? Pode sentar. O que que eu posso te ajudar hoje?",
			},
			{
				speaker: "patient",
				text: "Ai, doutora, é que eu tô com uma dor de cabeça, mas é uma dor de cabeça que não passa, sabe? Já faz, ai, uns vinte dias mais ou menos. Começou do nada, eu tava trabalhando no computador, e de repente começou uma pontada aqui do lado, do lado esquerdo.",
			},
			{
				speaker: "doctor",
				text: "Entendi. E essa dor, ela é constante o dia todo ou vai e volta?",
			},
			{
				speaker: "patient",
				text: "Vai e volta, mas quando vem é forte, tipo uma pressão, sabe? E junto vem uma tontura, eu sinto o chão meio mole. Ah, e eu também ando dormindo mal, porque a cabeça não para de latejar de noite.",
			},
			{
				speaker: "doctor",
				text: "A senhora toma algum remédio pra dor? E tem alergia a algum medicamento?",
			},
			{
				speaker: "patient",
				text: "Tomo dipirona, tomo duas cápsulas de 500 mg quando tá doendo muito, mas confesso que não é todo dia. E alergia, não tenho alergia a remédio nenhum, pode ficar tranquila.",
			},
			{
				speaker: "doctor",
				text: "Certo. A senhora tem pressão alta, diabetes, ou toma algum remédio de uso contínuo?",
			},
			{
				speaker: "patient",
				text: "Pressão eu nunca medi direito, mas meu marido diz que eu sou nervosa. Remédio de uso contínuo eu não tomo não, só a dipirona mesmo, e só quando precisa.",
			},
			{
				speaker: "doctor",
				text: "Vou medir a pressão da senhora e olhar sua pupila, tá? Respira fundo pra mim... Trinta e oito, setenta e dois. Tá um pouquinho alta, mas nada alarmante. Vou pedir um hemograma e ver se precisa de um exame de imagem da cabeça. Enquanto isso, vou passar um analgésico mais forte pra usar só se a dor apertar.",
			},
			{
				speaker: "patient",
				text: "Ai, doutora, e se for alguma coisa séria? Porque meu pai teve um AVC, né, então eu fico com medo.",
			},
			{
				speaker: "doctor",
				text: "Entendo o medo, mas pelo que a senhora descreveu, parece mais tensão e falta de sono do que algo grave. Os exames vão confirmar. Se aparecer qualquer sinal de alerta — dormência no braço, fala enrolada, confusão — a senhora vai na emergência na hora, tá? Anotou?",
			},
			{
				speaker: "patient",
				text: "Anotei sim. E a senhora vai me passar o remédio aqui mesmo ou eu preciso ir na farmácia do posto?",
			},
			{
				speaker: "doctor",
				text: "Vou prescrever na receituário, a senhora retira na farmácia. São dois comprimidos de seis em seis horas, só se a dor apertar, máximo quatro vezes ao dia. E tenta dormir mais cedo essa semana, viu? O cansaço tá deixando a senhora mais sensível.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora. Muito obrigada, viu? Semana que vem eu volto com os exames?",
			},
			{
				speaker: "doctor",
				text: "Isso, semana que vem no mesmo horário. Qualquer coisa diferente antes disso, não espera — me procura. Tchau, dona Helena.",
			},
		],
		entities: [
			{ category: "medication", value: "dipirona" },
			{ category: "dosage", value: "500 mg" },
			{ category: "negation", value: "não tenho alergia" },
			{ category: "frequency", value: "seis em seis horas" },
		],
	},
	{
		slug: "gp-checkup-02",
		specialty: "general_practice",
		region: "south",
		ageBand: "adult",
		register: "formal",
		gender: "m",
		socialClass: "b",
		education: "higher",
		patientName: "Paciente Rui",
		doctor: { gender: "m", register: "formal" },
		turns: [
			{ speaker: "doctor", text: "Bom dia, senhor Rui. Em que posso ajudá-lo hoje?" },
			{
				speaker: "patient",
				text: "Bom dia, doutor. Vim fazer aquele check-up anual que a gente combinou da última vez. Inclusive eu já trouxe os exames de sangue que fiz mês passado — está tudo aqui na pasta.",
			},
			{
				speaker: "doctor",
				text: "Perfeito, muito organizado. Deixa eu ver... Colesterol um pouco alto, LDL em cento e quarenta, mas o restante do hemograma está dentro do normal. A pressão hoje mediu cento e trinta e oito por oitenta e seis — um pouco elevada.",
			},
			{
				speaker: "patient",
				text: "Pois é, doutor, eu sei. O problema é que eu trabalho sentado o dia inteiro, e confesso que exagerei no sal e no churrasco esse verão todo.",
			},
			{
				speaker: "doctor",
				text: "Entendo, mas precisamos agir antes que vire problema. O senhor já toma algum remédio contínuo? E tem alergia a algo?",
			},
			{
				speaker: "patient",
				text: "Não tomo remédio nenhum, e alergia eu não tenho, graças a Deus. Só tomo um ibuprofeno de vez em quando quando bate aquela dor nas costas de ficar sentado.",
			},
			{
				speaker: "doctor",
				text: "Certo. Então o plano é o seguinte: vou prescrever uma estatina em dose baixa, sinvastatina vinte miligramas, uma vez ao dia à noite. E vou pedir pra senhora... digo, pro senhor voltar em trinta dias pra eu reavaliar a pressão e repetir o colesterol. Enquanto isso,.reduce o sal e tenta caminhar trinta minutos por dia, três vezes na semana.",
			},
			{
				speaker: "patient",
				text: "Trinta minutos é muito, doutor, mas eu posso começar com quinze e ir aumentando. E a estatina tem efeito colateral? Pergunto porque meu pai teve dor muscular com remédio de colesterol.",
			},
			{
				speaker: "doctor",
				text: "Pode dar dor muscular sim, é o efeito mais comum. Se o senhor sentir fraqueza ou dor nos músculos, me avisa que a gente troca. Mas na dose baixa que eu vou passar, a maioria tolera bem. E se a pressão continuar alta na próxima consulta, aí sim a gente conversa sobre remédio pra pressão.",
			},
			{
				speaker: "patient",
				text: "Justo. Doutor, e o senhor acha que preciso fazer algum exame de imagem ou cardiológico também?",
			},
			{
				speaker: "doctor",
				text: "Por ora não — o senhor está assintomático e o risco é baixo. Mas como tem histórico familiar, vou deixar anotado pra gente reavaliar em seis meses. Qualquer dor no peito, falta de ar ou desmaio, procure emergência imediatamente, tá?",
			},
			{
				speaker: "patient",
				text: "Combinado. Obrigado pela atenção, doutor. Até daqui a trinta dias, então.",
			},
			{
				speaker: "doctor",
				text: "Isso mesmo. A recepção já deixa o retorno marcado. Cuide-se, senhor Rui.",
			},
		],
		entities: [
			{ category: "medication", value: "sinvastatina" },
			{ category: "dosage", value: "vinte miligramas" },
			{ category: "frequency", value: "uma vez ao dia" },
			{ category: "negation", value: "alergia eu não tenho" },
			{ category: "date", value: "trinta dias" },
		],
	},
	{
		slug: "gp-lombalgia-03",
		specialty: "general_practice",
		region: "northeast",
		ageBand: "elderly",
		register: "colloquial",
		gender: "f",
		socialClass: "d",
		education: "elementary",
		patientName: "Paciente Marta",
		doctor: { gender: "f", register: "colloquial" },
		turns: [
			{
				speaker: "doctor",
				text: "Oi, dona Marta, tudo bom? Senta aqui, filha. O que que tá doendo hoje?",
			},
			{
				speaker: "patient",
				text: "Ai, doutora, é essa lombar de novo, viu? Faz uns três meses que eu tô com essa dorzinha aqui embaixo, na coluna. Piorou agora porque eu tive que pegar peso, ajudar minha filha a mudar de casa.",
			},
			{
				speaker: "doctor",
				text: "Entendi. A dor desce pra perna ou fica só aqui na lombar? E o senhora sente dormência, fraqueza na perna?",
			},
			{
				speaker: "patient",
				text: "Fica só na lombar, não desce pra perna não. Mas tem dia que eu não consigo nem me abaixar pra calçar o sapato, é um aperto danado.",
			},
			{
				speaker: "doctor",
				text: "Vou te examinar aqui, tá? Deita de lado pra mim... Pronto, aqui dói? Respira... É, tá inflamada essa região. A senhora toma algum remédio?",
			},
			{
				speaker: "patient",
				text: "Tomo o remédio da pressão, a losartana, todo dia de manhã, cem miligramas. E quando a lombar aperta eu tomo dipirona, mas só quando precisa mesmo.",
			},
			{
				speaker: "doctor",
				text: "Tá, então a gente vai tomar cuidado pra não misturar remédio. A losartana continua igual, não mexe nela. Pra lombar eu vou passar um anti-inflamatório, mas em dose baixa porque a senhora tem pressão alta. E tem alergia a algum remédio, dona Marta?",
			},
			{
				speaker: "patient",
				text: "Alergia não tenho nenhuma, graças a Deus. Só que assim, eu não posso ficar tomando muito remédio forte porque meu estômago já é sensível, eu tenho gastrite.",
			},
			{
				speaker: "doctor",
				text: "Ah, entendi, gastrite complica. Então vou evitar o anti-inflamatório e usar só o paracetamol, que é mais suave pro estômago. Um comprimido de oitocentos miligramas, de seis em seis horas se precisar, máximo quatro vezes ao dia. E vou te encaminhar pra fisioterapia, tá? Lá eles te ensinam exercício pra fortalecer a lombar.",
			},
			{
				speaker: "patient",
				text: "Fisioterapia, ai minha filha, eu tenho medo de não ter jeito não. Mas se a senhora manda, eu vou, viu? Só me ajuda a conseguir o encaminhamento que eu não sei como é que faz.",
			},
			{
				speaker: "doctor",
				text: "Eu faço o encaminhamento aqui mesmo, na recepção eles marcam. E dona Marta, uma coisa importante: se a dor descer pra perna, se a senhora perder força pra andar, ou começar a formigar a perna, corre pra emergência, viu? Isso é sinal de que apertou algum nervo.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora, eu vou ficar de olho. E eu posso continuar fazendo as coisas de casa normal ou devo descansar?",
			},
			{
				speaker: "doctor",
				text: "Pode continuar, mas sem pegar peso. Nada de levantar panela cheia, saco de mercado, nada disso. O resto, vai fazendo devagar. Em uma semana eu quero te ver de novo pra ver como tá.",
			},
			{
				speaker: "patient",
				text: "Combinado, doutora. Muito obrigada, viu? Deus abençoe a senhora.",
			},
			{
				speaker: "doctor",
				text: "Imagina, dona Marta. Qualquer coisa me procura, tá? Tchau, viu?",
			},
		],
		entities: [
			{ category: "medication", value: "losartana" },
			{ category: "dosage", value: "cem miligramas" },
			{ category: "medication", value: "paracetamol" },
			{ category: "dosage", value: "oitocentos miligramas" },
			{ category: "frequency", value: "de seis em seis horas" },
			{ category: "negation", value: "Alergia não tenho" },
		],
	},
];
