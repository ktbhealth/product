import type { PtbrConsult } from "./types.ts";

/**
 * Cardiologia — 3 authored consults.
 * Chest-discomfort workup, palpitations/anticoagulation follow-up,
 * statin/lipid management. Noise: anxious patient register, numbers
 * (doses, vitals, dates), medication brand+generic pairs.
 */
export const CARDIOLOGY: readonly PtbrConsult[] = [
	{
		slug: "card-dor-toracica-01",
		specialty: "cardiology",
		region: "southeast",
		ageBand: "adult",
		register: "formal",
		gender: "m",
		socialClass: "b",
		education: "higher",
		patientName: "Paciente Davi",
		doctor: { gender: "m", register: "formal" },
		turns: [
			{
				speaker: "doctor",
				text: "Bom dia, senhor Davi. Sentado, por favor. O que o traz à consulta hoje?",
			},
			{
				speaker: "patient",
				text: "Doutor, eu vim porque esses dias eu senti uma dor aqui no peito, do lado esquerdo, quando eu tava subindo escada no trabalho. Foi uns três dias atrás. Dura uns dez segundos e passa, mas me deixou preocupado.",
			},
			{
				speaker: "doctor",
				text: "Dez segundos é um tempo curto, o que é bom sinal, mas vamos investigar direito. A dor irradiou pro braço ou pro maxilar? O senhor sentiu falta de ar, sudorese, náusea junto?",
			},
			{
				speaker: "patient",
				text: "Irradiou não, ficou só no peito mesmo. Falta de ar não senti, mas suei frio na hora, confesso. E depois que desci a escada e sentei um pouco, passou.",
			},
			{
				speaker: "doctor",
				text: "Entendi. O senhor fuma? Toma remédio pra pressão ou colesterol? E tem histórico familiar de problema no coração?",
			},
			{
				speaker: "patient",
				text: "Fumo não, parei há uns cinco anos. Remédio eu não tomo nenhum. Meu pai teve um infarto aos sessenta e dois anos, então eu fico meio receoso por causa disso.",
			},
			{
				speaker: "doctor",
				text: "O histórico familiar pesa sim, mas vamos com calma. Vou pedir um eletrocardiograma e uma prova de esforço, e já vou medir a pressão. Cento e quarenta e dois por oitenta e nove — um pouco alta. O senhor dorme bem? Está estressado no trabalho?",
			},
			{
				speaker: "patient",
				text: "Doutor, estresse é o que não falta, né? Fecho projeto atrás de projeto. Dormir eu durmo, mas é sono quebrado, acordo umas três da manhã pensando nas coisas.",
			},
			{
				speaker: "doctor",
				text: "Pois é, o estresse somado à pressão um pouco alta pode explicar a dor. Mas pela sua história familiar eu não vou deixar barato — os exames vão nos dizer. Enquanto isso, se a dor voltar, se for mais forte, ou vier acompanhada de falta de ar, não espera: ligue pro SAMU ou venha direto na emergência, tá?",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutor. E se os exames derem tudo normal, eu posso continuar fazendo academia normal?",
			},
			{
				speaker: "doctor",
				text: "Se derem normal, pode continuar, mas com um detalhe: naquela semana dos exames eu prefiro que o senhor faça caminhada leve em vez de musculação pesada, até a gente confirmar. A recepção vai te passar o agendamento da prova de esforço. Em uma semana eu te vejo com os resultados, tá?",
			},
			{
				speaker: "patient",
				text: "Perfeito, doutor. Muito obrigado pela atenção. Semana que vem então.",
			},
			{
				speaker: "doctor",
				text: "Isso. Qualquer dor no peito que não passe em dois minutos, é emergência — não vem na consulta, vai direto pro pronto-socorro. Combinado?",
			},
		],
		entities: [
			{ category: "unit", value: "três da manhã" },
			{ category: "date", value: "uma semana" },
			{ category: "negation", value: "Fumo não" },
		],
	},
	{
		slug: "card-palpitacoes-02",
		specialty: "cardiology",
		region: "south",
		ageBand: "elderly",
		register: "colloquial",
		gender: "f",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Sofia",
		doctor: { gender: "f", register: "formal" },
		turns: [
			{ speaker: "doctor", text: "Boa tarde, dona Sofia. O que que a senhora está sentindo?" },
			{
				speaker: "patient",
				text: "Ai doutora, eu tô preocupada porque esses dias o meu coração fica disparado, sabe? Do nada ele começa a bater muito forte, tipo um baque, e fica uns cinco, seis minutos assim, depois volta ao normal. Já aconteceu umas quatro vezes esse mês.",
			},
			{
				speaker: "doctor",
				text: "Cinco, seis minutos é tempo suficiente pra eu levar a senhora a sério. Quando isso acontece, a senhora sente tontura, falta de ar ou desmaio?",
			},
			{
				speaker: "patient",
				text: "Tontura sente um pouquinho, sim, e o peito fica meio apertado. Desmaiar eu nunca desmaiei, graças a Deus. Mas a senhora é que sabe, né, eu tenho setenta e oito anos.",
			},
			{
				speaker: "doctor",
				text: "Setenta e oito anos não é motivo pra se preocupar, é motivo pra investigar bem. A senhora toma remédio pra coração ou pressão? Me fala tudo que usa, inclusive o que compra na farmácia sem receita.",
			},
			{
				speaker: "patient",
				text: "Uso a losartana, cinquenta miligramas de manhã, e a sinvastatina também. Ah, e tomo um chá de capim-santo que minha filha me deu, mas só de vez em quando. Remédio pra coração de venda livre eu não tomo.",
			},
			{
				speaker: "doctor",
				text: "Anotado. Vou pedir um Holter, que é um aparelho que a senhora fica com vinte e quatro horas registrando o coração, e um ecocardiograma. Com esses dois exames eu consigo ver se é arritmia e como está o músculo do coração. A senhora tem alergia a algum remédio?",
			},
			{
				speaker: "patient",
				text: "Alergia eu não tenho de remédio nenhum, não. Só de picada de formiga eu fico inchada, mas isso não tem nada a ver, né?",
			},
			{
				speaker: "doctor",
				text: "Tem sim, informação boa — anotado. Enquanto a senhora faz os exames, vou manter a losartana e a sinvastatina como estão. Se as palpitações aumentarem, se passar de dez minutos ou vier com desmaio, a senhora vem direto aqui pro pronto-socorro, não espera, tá?",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora. E eu posso continuar subindo escada normal, caminhando na rua?",
			},
			{
				speaker: "doctor",
				text: "Pode sim, caminhar é ótimo pra senhora. Mas no dia que sentir o coração disparado, para o que estiver fazendo, senta, respira fundo e me conta depois como foi. Anotou?",
			},
			{
				speaker: "patient",
				text: "Anotei direitinho. Muito obrigada, doutora. A senhora é muito atenciosa.",
			},
			{
				speaker: "doctor",
				text: "Que isso. Os exames saem em uns três dias, a recepção te liga pra marcar. Qualquer coisa, me procura antes. Tchau, dona Sofia.",
			},
		],
		entities: [
			{ category: "medication", value: "losartana" },
			{ category: "dosage", value: "cinquenta miligramas" },
			{ category: "medication", value: "sinvastatina" },
			{ category: "negation", value: "Alergia eu não tenho" },
			{ category: "date", value: "três dias" },
		],
	},
	{
		slug: "card-colesterol-03",
		specialty: "cardiology",
		region: "northeast",
		ageBand: "adult",
		register: "colloquial",
		gender: "m",
		socialClass: "d",
		education: "elementary",
		patientName: "Paciente Nilo",
		doctor: { gender: "m", register: "colloquial" },
		turns: [
			{ speaker: "doctor", text: "E aí, Nilo, tudo certo? Senta aqui. O que que te traz hoje?" },
			{
				speaker: "patient",
				text: "É que eu vim porque meu colesterol deu alto no exame de rotina, doutor. O clínico falou que eu tenho que vir no cardiologista, mas eu tô meio assim, porque não sinto nada, né? Tô bem, trabalho o dia todo, sem dor nenhuma.",
			},
			{
				speaker: "doctor",
				text: "Justamente por isso que é importante vir — colesterol alto é traiçoeiro, não dá sintoma. Me mostra o exame aí. Deixa eu ver... LDL em cento e sessenta e dois, HDL baixo em trinta e cinco. O senhor tem pressão alta? Diabetes? Toma remédio?",
			},
			{
				speaker: "patient",
				text: "Pressão eu tenho sim, tomo anlodipino, cinco miligramas todo dia. Diabetes não tenho. Remédio de colesterol não tomo ainda, essa é a primeira vez que dá alto.",
			},
			{
				speaker: "doctor",
				text: "Tá, então vamos combinar as duas coisas. O anlodipino continua igual, não muda nada. E pro colesterol eu vou passar uma estatina, a rosuvastatina, dez miligramas, uma vez ao dia à noite. Mas Nilo, remédio sozinho não resolve — o senhor precisa cortar fritura e refrigerante, e andar pelo menos trinta minutos por dia. Consegue?",
			},
			{
				speaker: "patient",
				text: "Doutor, refrigerante é difícil porque eu trabalho de motoboy e tomo pra não dormir no trânsito. Mas fritura eu corto sim, minha mulher já reclama. Caminhar trinta minutos... eu posso ir a pé nas entregas, isso conta?",
			},
			{
				speaker: "doctor",
				text: "Conta sim, e muito — motoboy anda mais que muita gente. Só troca o refrigerante por água nos horários que der, não precisa ser de uma vez. E se a estatina der dor muscular, para e me procura, tá? Não fica com vergonha de voltar, isso é comum.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutor. E quando é que eu repito o exame pra ver se baixou?",
			},
			{
				speaker: "doctor",
				text: "Em uns três meses eu quero ver um novo colesterol. A recepção te marca. E ó, se aparecer dor no peito, falta de ar ou inchaço nas pernas, não espera a consulta — vem na emergência direto, viu?",
			},
			{
				speaker: "patient",
				text: "Fechou, doutor. Valeu pela explicação, eu não fazia ideia que colesterol fazia mal sem eu sentir nada.",
			},
			{
				speaker: "doctor",
				text: "É isso aí que pega todo mundo, Nilo. Exame não mente. Três meses, hein? Qualquer coisa me liga. Tchau, viu?",
			},
		],
		entities: [
			{ category: "medication", value: "anlodipino" },
			{ category: "dosage", value: "cinco miligramas" },
			{ category: "medication", value: "rosuvastatina" },
			{ category: "dosage", value: "dez miligramas" },
			{ category: "frequency", value: "uma vez ao dia" },
			{ category: "date", value: "três meses" },
		],
	},
];
