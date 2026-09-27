# Dividir Conta

Aplicativo mobile-first para organizar despesas compartilhadas, inspirado no fluxo de aplicativos como Splitwise.

## Recursos

- Múltiplos eventos independentes.
- Participantes por evento.
- Renomear e remover participantes quando não há movimentações vinculadas.
- Cadastro de despesas com descrição, valor, pagador e data.
- Divisão igual entre qualquer quantidade de pessoas.
- Divisão personalizada por valores.
- Distribuição exata dos centavos.
- Edição e exclusão de despesas.
- Saldo líquido de cada participante.
- Algoritmo de acerto que reduz a quantidade de transferências.
- Registro de pagamentos/“Paguei”.
- Desfazer pagamentos.
- Quitação de todos os acertos pendentes.
- Histórico de pagamentos.
- Compartilhamento do resumo usando o recurso nativo do celular.
- Exportação completa do evento em JSON.
- Moedas BRL, USD e EUR.
- Interface responsiva para iPhone.
- Persistência local no navegador.

## Como funciona o cálculo

Cada despesa registra quem pagou e quanto cada participante deve assumir. O saldo líquido é:

**valor pago - valor devido + pagamentos realizados como devedor - pagamentos recebidos como credor.**

Saldo positivo significa que a pessoa tem dinheiro a receber; saldo negativo significa que ela precisa pagar.

O módulo de acertos combina credores e devedores até zerar os saldos, buscando uma solução com poucas transferências.

## Privacidade

Nesta versão, os dados ficam no armazenamento local do navegador/dispositivo. Não existe servidor nem banco de dados conectado.

## Próxima arquitetura possível

Para transformar o projeto em um aplicativo colaborativo, o próximo passo técnico é trocar o armazenamento local por uma API/banco de dados e adicionar autenticação e convites.