#!/usr/bin/env node
'use strict';

// Admin tool that works directly on the database.
// Usage: npm run cli -- <command> [args]

const { loadConfig } = require('../src/config');
const { createServices } = require('../src/server');

const HELP = `
Commands:
  create <email> <displayName> <password>   Create an account
  list                                      List accounts
  info <name|id>                            Show an account
  vbucks <name|id> <amount>                 Set V-Bucks
  grant <name|id> <templateId...>           Give items, e.g. AthenaCharacter:CID_028_Athena_Commando_F
  ban <name|id>  /  unban <name|id>         Ban or unban
  admin <name|id> <on|off>                  Mark as admin
  password <name|id> <newPassword>          Reset password
  delete <name|id>                          Delete an account
`;

function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help') return console.log(HELP);

  const services = createServices(loadConfig(), { log() {}, warn: console.warn, error: console.error });
  const find = (key) => {
    const account = services.accounts.findById(key) || services.accounts.findByDisplayName(key) || services.accounts.findByEmail(key);
    if (!account) throw new Error(`No account matches "${key}"`);
    return account;
  };

  try {
    switch (command) {
      case 'create': {
        const [email, displayName, password] = args;
        const account = services.accounts.create({ email, displayName, password });
        services.profiles.createDefaults(account.id);
        console.log(`Created ${account.displayName} (${account.id})`);
        break;
      }
      case 'list':
        for (const a of services.accounts.list()) {
          console.log(`${a.id}  ${a.displayName.padEnd(16)}  ${a.email}${a.banned ? '  [BANNED]' : ''}${a.isAdmin ? '  [ADMIN]' : ''}`);
        }
        break;
      case 'info': {
        const a = find(args[0]);
        const core = services.profiles.get(a.id, 'common_core');
        const athena = services.profiles.get(a.id, 'athena');
        console.log({ ...a, passwordHash: undefined, vbucks: core.items['Currency:MtxPurchased'].quantity, items: Object.keys(athena.items).length });
        break;
      }
      case 'vbucks':
        services.profiles.setVbucks(find(args[0]).id, Number(args[1]));
        console.log('Done');
        break;
      case 'grant': {
        const added = services.profiles.grantItems(find(args[0]).id, args.slice(1));
        console.log(`Added ${added.length} item(s)`);
        break;
      }
      case 'ban':
      case 'unban': {
        const a = find(args[0]);
        services.accounts.setBanned(a.id, command === 'ban');
        if (command === 'ban') services.tokens.revokeAllForAccount(a.id);
        console.log('Done');
        break;
      }
      case 'admin':
        services.accounts.setAdmin(find(args[0]).id, args[1] !== 'off');
        console.log('Done');
        break;
      case 'password':
        services.accounts.setPassword(find(args[0]).id, args[1]);
        services.tokens.revokeAllForAccount(find(args[0]).id);
        console.log('Done');
        break;
      case 'delete':
        services.accounts.delete(find(args[0]).id);
        console.log('Deleted');
        break;
      default:
        console.log(`Unknown command "${command}"`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    services.db.close();
  }
}

main(process.argv.slice(2));
