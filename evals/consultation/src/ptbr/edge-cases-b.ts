import type { PtbrConsult } from "./types.ts";

/**
 * Edge cases — 3 authored consults targeting ASR weak spots the
 * main cohort doesn't stress: self-correction loops around spoken
 * quantities (the FINAL value is the gold one), heavy colloquial /
 * regional register mixed with clinical terms, and interruption +
 * backchannel turn structure with emotional content. Same content
 * rules as the rest of ptbr/ — anamnesis/exam-plan only, no
 * diagnosis or treatment copy, synthetic display-tag names.
 */
export const EDGE_CASES_B: readonly PtbrConsult[] = [
	{
		slug: "psy-sonolencia-01",
		specialty: "psychiatry",
		region: "southeast",
		ageBand: "adult",
		register: "colloquial",
		gender: "f",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Inês",
		doctor: { gender: "m", register: "formal" },
		split: "train",
		axes: ["numeric-dense", "disfluency-heavy"],
		turns: [
			{
				speaker: "doctor",
				text: "Boa tarde, dona Inês. Senta aqui, pode ficar à vontade. O que que eu posso te ajudar hoje?",
			},
			{
				speaker: "patient",
				text: "Ai, doutor, é que eu tô... eu tô muito cansada, sabe? Não é cansada de trabalho não, é um cansaço que vem do nada. E eu durmo, durmo, mas acordo cansada. Aí eu tô tomando... eu tava tomando um remédio pra dormir, um... dois comprimidos na verdade, o... como é que chama... o clonazepam? Não, pera, é... é zolpidem? Ai, doutor, eu me confundo toda.",
			},
			{
				speaker: "doctor",
				text: "Calma, dona Inês, a gente vai organizar isso. Me conta melhor: há quanto tempo vem esse cansaço? E qual remédio você usa hoje, o nome que tá na caixa?",
			},
			{
				speaker: "patient",
				text: "O remédio é o... é o zolpidem, dez miligramas. Eu tomo... eu tomo meio comprimido... não, um comprimido inteiro, às dez da noite. Mas só quando não consigo dormir, porque tem noite que eu tomo dois, aí eu fico grogue no dia seguinte.",
			},
			{
				speaker: "doctor",
				text: "Entendi. E esse cansaço começou quando? Foi depois de algum evento, alguma mudança na sua vida?",
			},
			{
				speaker: "patient",
				text: "Foi... foi ano passado, mais ou menos. Meu marido... meu marido teve um problema de saúde, teve um AVC, e eu fiquei... eu fiquei muito preocupada. Aí eu perdi o sono, perdi a vontade de comer. Eu emagreci, eu pesava... eu pesava setenta e dois quilos, agora eu tô com sessenta e cinco. Em... em seis meses, doutor.",
			},
			{
				speaker: "doctor",
				text: "Sessenta e cinco, anotei. E você sente tristeza, choro fácil, ou pensamentos de que a vida não vale a pena? Pode me falar com sinceridade.",
			},
			{
				speaker: "patient",
				text: "Doutor, eu... eu fico pensando muito. Às vezes eu penso que seria melhor... melhor nem estar aqui. Mas eu não quero fazer nada com isso, eu tenho meus filhos, eu tenho... eu tenho que ficar bem por eles.",
			},
			{
				speaker: "doctor",
				text: "Obrigado por me contar, dona Inês — isso é muito importante e a gente vai cuidar disso junto. Você tem acompanhamento psicológico? E toma mais algum remédio, de pressão, de tireoide, alguma coisa?",
			},
			{
				speaker: "patient",
				text: "Psicólogo eu não tô indo não, parei. Remédio de pressão eu não tomo, porque eu nunca medi alta. Ah, mas eu tomo... eu tomo uma vitamina, ferro, porque o doutor anterior falou que eu tava anêmica. Toma... toma duas cápsulas por dia, de cem miligramas cada.",
			},
			{
				speaker: "doctor",
				text: "Certo. Vou pedir uns exames pra gente ver como tá o ferro, a tireoide e a vitamina D, porque cansaço assim tem várias causas. Enquanto isso, vou rever a medicação do sono — o zolpidem dez miligramas à noite é uma dose que precisa de ajuste, porque dois comprimidos explica a sonolência diurna. Vamos começar com meio comprimido, só se não dormir.",
			},
			{
				speaker: "patient",
				text: "Meio comprimido? Ai, doutor, eu tenho medo de não conseguir dormir de novo. Porque quando eu não durmo, eu fico... eu fico desesperada, sabe? Fico com aquela sensação de que o dia nunca acaba.",
			},
			{
				speaker: "doctor",
				text: "Entendo o medo, e faz sentido. A gente vai fazer assim: passo um sono de forma diferente, um remédio mais suave pra começar, e a gente marca um retorno em quinze dias. Se o sono não melhorar, a gente ajusta. E sobre a tristeza — vou te encaminhar pro serviço de psicologia da UBS, tá? Não é porque eu desconfio, é porque cansaço e tristeza andam juntos e a psicóloga ajuda muito.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutor. Eu vou tentar. Só me ajuda numa coisa: eu posso continuar tomando o ferro junto com... com esse remédio novo, ou tem que separar?",
			},
			{
				speaker: "doctor",
				text: "Pode tomar junto, sem problema, mas toma o ferro de manhã com o café, que absorve melhor. O remédio do sono é só à noite. E dona Inês, se a tristeza piorar, se você começar a pensar em se machucar, liga pro CAPS ou vem aqui na hora, tá? Isso é sério e eu tô levando a sério.",
			},
			{
				speaker: "patient",
				text: "Eu tô levando a sério também, doutor. Obrigada por não me julgar. Semana que vem eu volto?",
			},
			{
				speaker: "doctor",
				text: "Semana que vem sim, mesmo horário. E tenta anotar como dorme cada noite, me traz na próxima consulta. Tchau, dona Inês.",
			},
		],
		entities: [
			{ category: "medication", value: "zolpidem" },
			{ category: "dosage", value: "dez miligramas" },
			{ category: "dosage", value: "meio comprimido" },
			{ category: "medication", value: "ferro" },
			{ category: "dosage", value: "cem miligramas" },
			{ category: "frequency", value: "de manhã" },
			{ category: "negation", value: "Remédio de pressão eu não tomo" },
			{ category: "date", value: "quinze dias" },
		],
	},
	{
		slug: "card-pressao-01",
		specialty: "cardiology",
		region: "northeast",
		ageBand: "elderly",
		register: "colloquial",
		gender: "m",
		socialClass: "d",
		education: "elementary",
		patientName: "Paciente Juraci",
		doctor: { gender: "f", register: "colloquial" },
		split: "train",
		axes: ["colloquial", "disfluency-heavy"],
		turns: [
			{
				speaker: "doctor",
				text: "Oi, Seu Juraci, pode entrar, fica à vontade. O que que tá trazendo o senhor aqui hoje?",
			},
			{
				speaker: "patient",
				text: "Ai, doutora, é que eu ando... eu ando com um aperto no peito, sabe? Não é dor de... não é dor forte não, é tipo uma pressão, como se tivesse apertando. Começou faz umas duas semanas, mais ou menos. Mas eu acho que é porque eu exagerei no café, viu? Tomei... tomei umas cinco, seis xícaras num dia só, fiquei todo tremendo.",
			},
			{
				speaker: "doctor",
				text: "Entendi. E esse aperto acontece quando? Em repouso, quando caminha, quando sobe escada? E passa sozinho ou fica?",
			},
			{
				speaker: "patient",
				text: "Fica, doutora. Fica uns cinco minutinhos e passa. Mas agora eu tô com medo, viu? Porque meu finado pai teve... teve um problema no coração e morreu rápido. Eu fico pensando: e se for a mesma coisa comigo?",
			},
			{
				speaker: "doctor",
				text: "Vou te examinar e a gente vê. Antes, me conta: o senhor fuma? Bebe? E toma algum remédio?",
			},
			{
				speaker: "patient",
				text: "Fumo não, nunca fumei, graças a Deus. Bebo... bebo uma cervejinha no fim de semana, só. Remédio eu tomo... eu tomo o remédio da pressão, aquele losartana, cinquenta miligramas, todo dia. E tomo também... também um remédio pra próstata, o... o tamoxifeno? Não, pera, é... é tamsulosina. Esse mesmo.",
			},
			{
				speaker: "doctor",
				text: "Tá, anotado: losartana cinquenta miligramas e tamsulosina. O senhor tem diabetes? E a pressão, costuma medir como?",
			},
			{
				speaker: "patient",
				text: "Diabetes não tenho não. Pressão eu meço às vezes, fica por cento e cinquenta, cento e sessenta... não sei bem dizer, mas a moça da farmácia fala que tá alta. Eu como bastante, doutora, comida caseira, arroz, feijão, mas também gosto de um salgadinho, uma linguiça.",
			},
			{
				speaker: "doctor",
				text: "Vou medir a pressão agora, tá? Respira... Cento e cinquenta e oito por noventa e dois. Tá alta mesmo. E vou escutar seu coração... hum, tem um sopro leve, vou anotar. O senhor sentiu o coração acelerado, ou falta de ar em algum momento?",
			},
			{
				speaker: "patient",
				text: "Acelerado já senti... já senti sim, doutora, de noite, deitado. Aí eu fico acordado, o coração batendo, batendo. Mas passa quando eu levanto e ando um pouco pela casa. Falta de ar eu não sinto não, só esse aperto no peito e o coração acelerado.",
			},
			{
				speaker: "doctor",
				text: "Anotei. Vou pedir um eletrocardiograma e um exame de sangue pra ver o colesterol e a glicose, tá? E vou ver a pressão — a losartana cinquenta pode não estar bastando. Mas o senhor não para de tomar sozinho, viu? A gente muda com acompanhamento.",
			},
			{
				speaker: "patient",
				text: "Ah, e doutora, eu andei reparando que minha perna incha de noite, fica assim, ó, grossa. Será que é da pressão?",
			},
			{
				speaker: "doctor",
				text: "Pode ser, a pressão alta sobrecarrega o coração. Anotei isso também — inchaço na perna à noite. Se o inchaço vier com falta de ar, procura na hora, viu? E o aperto no peito que aperta de vez, com dor no braço ou no queixo, ou desmaio, é emergência, não espera.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora. Eu anoto isso. Eu não paro de tomar remédio não, viu? Só me preocupa esse aperto, porque parece... parece que vai parar de uma vez, sabe? Tipo o meu pai. Eu durmo mal por causa disso, fico ansioso.",
			},
			{
				speaker: "doctor",
				text: "Entendo o medo, Seu Juraci, e é bom que o senhor veio. Mas pelo que você descreveu — aperto que vem e passa, ligado ao café e ao coração acelerado — a gente vai investigar direitinho. Vou pedir o eletrocardiograma e você volta em duas semanas com o resultado, tá bom?",
			},
			{
				speaker: "patient",
				text: "Duas semanas eu volto, doutora. Muito obrigado, viu? A senhora é uma médica boa, fala com a gente direito. Deus abençoe.",
			},
			{
				speaker: "doctor",
				text: "Imagina, Seu Juraci. Cuida da alimentação, evita o sal, e qualquer coisa diferente me procura. Tchau, viu?",
			},
		],
		entities: [
			{ category: "medication", value: "losartana" },
			{ category: "dosage", value: "cinquenta miligramas" },
			{ category: "medication", value: "tamsulosina" },
			{ category: "negation", value: "nunca fumei" },
			{ category: "date", value: "duas semanas" },
		],
	},
	{
		slug: "geri-arritmia-01",
		specialty: "geriatrics",
		region: "south",
		ageBand: "elderly",
		register: "colloquial",
		gender: "f",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Neusa",
		doctor: { gender: "f", register: "formal" },
		split: "heldout",
		axes: ["interruptions", "disfluency-heavy"],
		turns: [
			{
				speaker: "doctor",
				text: "Bom dia, dona Neusa. Tudo bem? Pode sentar, não precisa se apressar.",
			},
			{
				speaker: "patient",
				text: "Bom dia, doutora. Ai, doutora, eu vim porque... porque eu tô com um medo, viu? Não é dor não, é medo mesmo. É que eu... eu tinha um problema no coração, fiz uma cirurgia faz... faz uns cinco anos, e agora essa semana eu acordei de noite, o coração disparado, disparado, e eu fiquei... fiquei com aquela coisa, sabe? Achei que ia morrer.",
			},
			{
				speaker: "doctor",
				text: "Entendi, dona Neusa. Isso é bem assustador mesmo. Você acordou e o coração tava acelerado? E passou sozinho ou você tomou alguma coisa?",
			},
			{
				speaker: "patient",
				text: "Uhum... passou, passou sim. Eu tomei... eu tomei um... um calmante que eu tinha em casa, aquele... aquele tal de... ahn, o... o Rivotril? Isso, Rivotril, meio comprimido, e aí eu dormi. Mas doutora, eu fiquei pensando na minha filha, que também tem problema de coração, ela faz tratamento no... no Hospital de Clínicas. E eu fico pensando: e se for genético, sabe?",
			},
			{
				speaker: "doctor",
				text: "Boa pergunta, mas vamos por partes. Antes de tudo, vou medir sua pressão e ver seu coração. Respira fundo pra mim... Trinta e dois... oitenta. Normal, a senhora tá tranquila agora.",
			},
			{
				speaker: "patient",
				text: "Agora sim, doutora, agora eu tô mais calma. Mas é que... é que eu não durmo direito, viu? Eu fico acordada, fico ouvindo o coração, 'bater, bater', e eu fico... fico contando os batimentos, doutora. Isso não é normal, né?",
			},
			{
				speaker: "doctor",
				text: "Não é o ideal, não. A senhora tá ansiosa, e ansiedade faz o coração acelerar mais. Quando foi a última vez que a senhora passou com cardiologista?",
			},
			{
				speaker: "patient",
				text: "Ai, doutora, eu... eu não lembro direito. Faz uns... uns oito meses? Talvez nove. Eu marquei uma vez, mas aí minha filha ficou doente e eu faltei, e depois... depois eu fui deixando.",
			},
			{
				speaker: "doctor",
				text: "Anotei. E a senhora toma os remédios direitinho? O que que tá usando hoje?",
			},
			{
				speaker: "patient",
				text: "Tomo... tomo o... como é que chama... o Bisoprolol? Isso, Bisoprolol, um comprimido de... de vinte e cinco miligramas, todo dia de manhã. E tomo a... a sinvastatina também, quarenta miligramas. Esses eu tomo direitinho, não falho.",
			},
			{
				speaker: "doctor",
				text: "Perfeito. E a senhora sente falta de ar? Dor no peito? Coisa que aperta e não passa?",
			},
			{
				speaker: "patient",
				text: "Dor no peito... ai, doutora, às vezes eu sinto uma pontadinha aqui, mas passa rápido. Falta de ar eu não sinto não... ahn, sente... eu sinto quando subo escada, mas eu não subo escada quase nunca. O que mais me preocupa é o coração acelerado de noite, viu?",
			},
			{
				speaker: "doctor",
				text: "Anotado. Então o plano é esse: vou pedir um eletrocardiograma e um holter — é um aparelho que a senhora usa em casa, grudado no peito, que grava o coração por uns dias. Assim a gente vê se tem arritmia de verdade ou se é só ansiedade. E vou te encaminhar de volta pro cardiologista, tá? Não deixa pra depois.",
			},
			{
				speaker: "patient",
				text: "Holter, doutora? Ai, eu nunca usei isso. É difícil? Tipo... tipo um adesivo?",
			},
			{
				speaker: "doctor",
				text: "É tipo um adesivo mesmo, cinco eletrodos, a senhora toma banho normal. E dona Neusa, sobre o medo — a senhora fez bem em vir. Medo não é fraqueza, viu? É o corpo pedindo atenção. A senhora tem rede de apoio, a filha ajuda?",
			},
			{
				speaker: "patient",
				text: "Tenho, doutora, minha filha é uma santa. Ela vem aqui comigo sempre. Mas eu fico com vergonha de incomodar, sabe? Ela já tem problema dela, eu não quero... eu não quero ser mais um peso.",
			},
			{
				speaker: "doctor",
				text: "Dona Neusa, escuta: você não é peso nenhum. Cuidar da saúde não é incomodar, é se respeitar. A gente vai marcar o retorno daqui a dez dias com os resultados, e se o coração tiver alguma coisa, a gente trata. Se for só ansiedade, a gente cuida disso também. Tá bom?",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora. Eu... eu vou tentar ficar mais tranquila. Muito obrigada por me ouvir, viu? A senhora é muito boa.",
			},
			{
				speaker: "doctor",
				text: "Imagina. Qualquer coisa, não espera — me procura. Cuida da senhora, tá? Tchau.",
			},
		],
		entities: [
			{ category: "medication", value: "Rivotril" },
			{ category: "medication", value: "Bisoprolol" },
			{ category: "dosage", value: "vinte e cinco miligramas" },
			{ category: "medication", value: "sinvastatina" },
			{ category: "dosage", value: "quarenta miligramas" },
			{ category: "frequency", value: "todo dia de manhã" },
			{ category: "date", value: "dez dias" },
		],
	},
];
