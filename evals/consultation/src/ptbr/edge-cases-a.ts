import type { PtbrConsult } from "./types.ts";

/**
 * Edge cases — 3 authored pt-BR consults targeting ASR weak spots.
 * `negacao-densa`: stacked denials ("não tomo, não tenho, nunca fiz").
 * `polifarmacia`: multiple meds with doses/frequencies spoken aloud,
 * brand+generic names. `datas-code-switch`: ages, weights, dates, lab
 * values plus natural English code-switching ("check-up", "insulin").
 */
export const EDGE_CASES_A: readonly PtbrConsult[] = [
	{
		slug: "card-negacao-densa-01",
		specialty: "cardiology",
		region: "southeast",
		ageBand: "elderly",
		register: "colloquial",
		gender: "m",
		socialClass: "c",
		education: "elementary",
		patientName: "Paciente Otávio",
		doctor: { gender: "m", register: "formal" },
		split: "train",
		axes: ["negation-dense", "disfluency-heavy", "colloquial"],
		turns: [
			{
				speaker: "doctor",
				text: "Boa tarde, senhor Otávio. O que que eu posso fazer pelo senhor hoje?",
			},
			{
				speaker: "patient",
				text: "Ah, doutor, é que eu andei meio cansado ultimamente, sabe? Subir escada eu já começo a ficar ofegante, e de noite eu acordo meio ofegante também. Mas não é uma dor no peito não, viu, é mais esse cansaço mesmo.",
			},
			{
				speaker: "doctor",
				text: "Entendi. O senhor toma algum remédio? Remédio de pressão, de coração, qualquer coisa de uso contínuo?",
			},
			{
				speaker: "patient",
				text: "Remédio? Não tomo remédio nenhum não, doutor. Nem de pressão, nem de coração, nem de diabetes. Eu tomo só um chá de erva quando fico resfriado, mas remédio assim de farmácia, não tomo não.",
			},
			{
				speaker: "doctor",
				text: "Tá. E tem alergia a algum remédio, a algum componente?",
			},
			{
				speaker: "patient",
				text: "Alergia? Não tenho alergia a nada não, graças a Deus. Nunca tive reação a remédio nenhum. E a penicilina, ahn, já usei penicilina quando era jovem, na época que eu tinha umas dores de garganta, e não deu problema nenhum.",
			},
			{
				speaker: "doctor",
				text: "Bom saber. O senhor já teve alguma cirurgia? Infarto, AVC, alguma coisa assim?",
			},
			{
				speaker: "patient",
				text: "Cirurgia nunca fiz não, nunca precisei. Infarto também não, graças a Deus. AVC eu não tive. O mais perto disso foi uma pneumonia que eu peguei há uns três anos, mas foi só isso, remédio e passou.",
			},
			{
				speaker: "doctor",
				text: "Ok. O senhor fuma ou já fumou? E bebe?",
			},
			{
				speaker: "patient",
				text: "Fumar, nunca fumei na vida, nem cigarro, nem cigarrão. Bebida eu tomo uma cervejinha no fim de semana com os amigos, mas é uma ou duas só, não sou de beber muito não.",
			},
			{
				speaker: "doctor",
				text: "Certinho. Deixa eu medir a pressão do senhor e escutar o coração. Respira fundo... Trinta e nove, setenta e um. Um pouquinho alta. Vou pedir um eletrocardiograma e um ecocardiograma pra ver esse cansaço melhor, tá?",
			},
			{
				speaker: "patient",
				text: "Echocardiograma é aquele exame que cola uns fiozinhos no peito, né? Ah, e doutor, antes de eu ir, deixa eu perguntar: eu preciso parar de fazer alguma coisa ou não?",
			},
			{
				speaker: "doctor",
				text: "Por enquanto não — mas se sentir dor no peito, falta de ar muito forte ou desmaio, vai direto na emergência, tá? Não espera consulta marcada.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutor, eu anoto aqui no papel pra não esquecer. Muito obrigado pela atenção.",
			},
			{
				speaker: "doctor",
				text: "Isso. A recepção marca os exames e eu te vejo daqui a duas semanas com os resultados. Tchau, senhor Otávio.",
			},
		],
		entities: [
			{ category: "negation", value: "Não tomo remédio nenhum" },
			{ category: "negation", value: "Não tenho alergia a nada" },
			{ category: "negation", value: "Cirurgia nunca fiz" },
			{ category: "medication", value: "penicilina" },
			{ category: "frequency", value: "uma ou duas" },
		],
	},
	{
		slug: "orto-polifarmacia-01",
		specialty: "orthopedics",
		region: "south",
		ageBand: "elderly",
		register: "colloquial",
		gender: "f",
		socialClass: "b",
		education: "secondary",
		patientName: "Paciente Lúcia",
		doctor: { gender: "f", register: "colloquial" },
		split: "heldout",
		axes: ["polypharmacy", "disfluency-heavy"],
		turns: [
			{
				speaker: "doctor",
				text: "Oi, dona Lúcia, tudo bom? O que que tá te trazendo aqui hoje?",
			},
			{
				speaker: "patient",
				text: "Ah, doutora, é esse joelho direito que não para de doer, viu? Faz umas três semanas que eu tô assim. Começou depois que eu subi num banquinho pra trocar a lâmpada do quarto, e desde então ficou essa dorzinha aqui do lado de fora do joelho.",
			},
			{
				speaker: "doctor",
				text: "Entendi. A dor piora quando a senhora anda, sobe escada, ou fica do mesmo jeito o dia todo?",
			},
			{
				speaker: "patient",
				text: "Piora quando eu subo escada e quando eu fico muito tempo de pé. De manhã é pior, depois que eu ando um pouco até melhora um pouco, mas no fim do dia volta a doer. E tem dia que eu ouço um estalo quando dobro o joelho.",
			},
			{
				speaker: "doctor",
				text: "Ok, vou te examinar. Deita aqui pra mim, estica a perna... Pronto, aqui dói? E quando eu dobro, a senhora sente que o joelho trava?",
			},
			{
				speaker: "patient",
				text: "Dói sim, doutora. E trava não trava, mas eu sinto que ele não quer dobrar direito, sabe? Fica meio duro.",
			},
			{
				speaker: "doctor",
				text: "Certo. Agora me conta: a senhora toma algum remédio? Vou precisar saber tudo que a senhora usa, porque alguns não combinam com anti-inflamatório.",
			},
			{
				speaker: "patient",
				text: "Tomo sim, doutora, eu tomo vários. Eu tomo a losartana, cem miligramas, uma vez ao dia de manhã, pro coração. Tomo a metformina, quinhentos miligramas, duas vezes ao dia, pro açúcar. E tomo a sinvastatina, vinte miligramas, uma vez à noite, pro colesterol. Ah, e o omeprazol, vinte miligramas, uma vez ao dia em jejum, pro estômago.",
			},
			{
				speaker: "doctor",
				text: "Anotado tudo. E remédio pra dor a senhora toma também, né? O que que a senhora usa quando dói?",
			},
			{
				speaker: "patient",
				text: "Uso a dipirona quando precisa, e o ibuprofeno, quatrocentos miligramas, de seis em seis horas, mas só quando a dor tá forte mesmo. E a minha irmã me deu um gel chamado Voltaren pra passar no joelho, eu passo umas duas vezes ao dia.",
			},
			{
				speaker: "doctor",
				text: "Tá, então a gente vai ter cuidado com isso. Com tantos remédios, eu prefiro não passar anti-inflamatório por via oral agora. Vou te passar só o paracetamol pra tomar se precisar, um grama, de seis em seis horas, máximo quatro vezes ao dia. E o gel você pode continuar, mas não passar mais de quatro vezes ao dia no local. Vou pedir uma radiografia do joelho pra ver o que tá acontecendo.",
			},
			{
				speaker: "patient",
				text: "Radiografia é aquele raio-X, né? Ah, doutora, e eu posso continuar subindo escada e fazendo as coisas de casa? Porque eu cuido da minha neta, ela fica comigo de tarde.",
			},
			{
				speaker: "doctor",
				text: "Pode continuar, mas com cuidado. Nada de pegar peso, nada de subir em banquinho, viu? E se o joelho inchar, ficar vermelho ou quente, ou a dor ficar muito forte de repente, me procura antes da data marcada, tá?",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora, eu vou tomar cuidado. Muito obrigada, viu? Semana que vem eu volto com o exame?",
			},
			{
				speaker: "doctor",
				text: "Isso, em sete dias a gente vê o resultado e eu te reavalio. Qualquer coisa antes disso, me liga. Tchau, dona Lúcia.",
			},
		],
		entities: [
			{ category: "medication", value: "losartana" },
			{ category: "medication", value: "metformina" },
			{ category: "medication", value: "sinvastatina" },
			{ category: "medication", value: "omeprazol" },
			{ category: "medication", value: "Voltaren" },
			{ category: "dosage", value: "cem miligramas" },
			{ category: "dosage", value: "quinhentos miligramas" },
			{ category: "dosage", value: "vinte miligramas" },
			{ category: "dosage", value: "quatrocentos miligramas" },
			{ category: "dosage", value: "um grama" },
			{ category: "frequency", value: "duas vezes ao dia" },
			{ category: "frequency", value: "de seis em seis horas" },
			{ category: "frequency", value: "uma vez ao dia" },
			{ category: "frequency", value: "uma vez à noite" },
			{ category: "frequency", value: "quatro vezes ao dia no local" },
		],
	},
	{
		slug: "gp-datas-code-switch-01",
		specialty: "general_practice",
		region: "northeast",
		ageBand: "adult",
		register: "colloquial",
		gender: "f",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Camila",
		doctor: { gender: "f", register: "colloquial" },
		split: "train",
		axes: ["numeric-dense", "code-switch", "colloquial"],
		turns: [
			{
				speaker: "doctor",
				text: "Oi, Camila, tudo bem? Senta aqui, tá? O que que eu posso te ajudar hoje?",
			},
			{
				speaker: "patient",
				text: "Oi, doutora. Eu vim fazer aquele check-up que eu tava devendo, porque eu fiz uns exames mês passado e queria mostrar pra senhora. Eu tenho trinta e dois anos e pesava setenta e oito quilos na última vez que me pesei, mas agora acho que tô uns oitenta e dois, porque andei comendo mais.",
			},
			{
				speaker: "doctor",
				text: "Boa, vamos aproveitar. Me conta quando foi que você fez esses exames, o que que eles mostraram, tá?",
			},
			{
				speaker: "patient",
				text: "Eu fiz dia doze de março, lá no laboratório do posto. O hemograma deu tudo normal, mas a glicose deu cento e doze de jejum, e o colesterol total deu duzentos e quarenta. Aí a moça do laboratório me disse pra eu procurar médico rápido.",
			},
			{
				speaker: "doctor",
				text: "Ok, deixa eu ver os resultados aqui... Realmente a glicose tá um pouquinho alta pro jejum. A senhora toma algum remédio? Insulin, metformina, qualquer coisa?",
			},
			{
				speaker: "patient",
				text: "Insulin eu não tomo, não, doutora. Remédio eu não tomo nenhum, juro. Só tomo um chá de gengibre quando fico enjoada, mas isso é raro. E pressão eu nunca medi, mas eu acho que tô bem.",
			},
			{
				speaker: "doctor",
				text: "Vamos medir então, tá? ... Cento e trinta e cinco por oitenta e quatro. Tá um pouco elevada também. Camila, me conta: você tem um histórico familiar de diabetes? Sua mãe, sua avó, alguém tem?",
			},
			{
				speaker: "patient",
				text: "Tenho sim, doutora. Minha mãe tem diabetes, ela usa insulin todo dia. E meu pai tem pressão alta, ele toma losartana de manhã e à noite. Então eu já fico meio preocupada, porque eu vi o resultado da glicose e já fiquei com medo.",
			},
			{
				speaker: "doctor",
				text: "Faz sentido o medo. Mas a gente vai confirmar com um exame de glicemia de jejum repetido e talvez um teste de tolerância. Enquanto isso, vou te pedir pra caminhar trinta minutos por dia, cinco vezes na semana, e evitar doce e refrigerante. Em duas semanas a gente refaz os exames e eu te dou o feedback.",
			},
			{
				speaker: "patient",
				text: "Duas semanas é rápido, né? Eu trabalho o dia todo, doutora, chego em casa às sete da noite. Mas eu posso caminhar de manhã antes de trabalhar, uns vinte minutos talvez. E refrigerante eu tomo quase todo dia no almoço, vou tentar diminuir.",
			},
			{
				speaker: "doctor",
				text: "Vinte minutos já ajuda, e o que importa é ser constante, tá? A gente começa pequeno e vai aumentando. E me diz uma coisa: você dorme bem? Porque sono ruim também mexe com a glicose.",
			},
			{
				speaker: "patient",
				text: "Dormo mais ou menos, doutora. Eu deito umas onze da noite mas acordo umas cinco da manhã, porque tenho que levar meu filho na escola. É um sono meio picado, sabe?",
			},
			{
				speaker: "doctor",
				text: "Entendi. Anota isso pra gente conversar na próxima consulta também. Por agora, o plano é: repetir a glicemia em jejum, caminhar todo dia de manhã, cortar o refrigerante, e em duas semanas a gente vê como tá. Qualquer sintoma estranho — sede demais, ir muito no banheiro, visão turva — me procura antes.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora. Eu vou anotar tudo aqui no celular pra não esquecer. Muito obrigada, viu? Fico ansiosa esperando o resultado.",
			},
			{
				speaker: "doctor",
				text: "Relaxa, Camila, um exame alterado não é sentença, tá? A gente vai cuidar. Dia vinte e seis de março você volta aqui com os exames novos, tá bom?",
			},
			{
				speaker: "patient",
				text: "Combinado, doutora. Até dia vinte e seis, então. Tchau!",
			},
		],
		entities: [
			{ category: "unit", value: "trinta e dois anos" },
			{ category: "unit", value: "oitenta e dois" },
			{ category: "unit", value: "cento e doze" },
			{ category: "unit", value: "duzentos e quarenta" },
			{ category: "unit", value: "cento e trinta e cinco por oitenta e quatro" },
			{ category: "date", value: "dia doze de março" },
			{ category: "date", value: "vinte e seis de março" },
			{ category: "frequency", value: "trinta minutos por dia" },
			{ category: "frequency", value: "cinco vezes na semana" },
			{ category: "frequency", value: "de manhã e à noite" },
			{ category: "medication", value: "losartana" },
			{ category: "negation", value: "Remédio eu não tomo nenhum" },
		],
	},
];
