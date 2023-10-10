import { createInterface } from 'readline';
import { ACCOUNT_STORAGE_DESCRIPTION } from '../../identity/interaction/account/util/BaseAccountStore';
import type { AccountLoginStorage } from '../../identity/interaction/account/util/LoginStorage';
import { ACCOUNT_TYPE } from '../../identity/interaction/account/util/LoginStorage';
import {
  CLIENT_CREDENTIALS_STORAGE_DESCRIPTION,
  CLIENT_CREDENTIALS_STORAGE_TYPE,
} from '../../identity/interaction/client-credentials/util/BaseClientCredentialsStore';
import {
  PASSWORD_STORAGE_DESCRIPTION,
  PASSWORD_STORAGE_TYPE,
} from '../../identity/interaction/password/util/BasePasswordStore';
import {
  OWNER_STORAGE_DESCRIPTION,
  OWNER_STORAGE_TYPE,
  POD_STORAGE_DESCRIPTION,
  POD_STORAGE_TYPE,
} from '../../identity/interaction/pod/util/BasePodStore';
import { WEBID_STORAGE_DESCRIPTION, WEBID_STORAGE_TYPE } from '../../identity/interaction/webid/util/BaseWebIdStore';
import { getLoggerFor } from '../../logging/LogUtil';
import type { KeyValueStorage } from '../../storage/keyvalue/KeyValueStorage';
import { Initializer } from '../Initializer';

type Account = {
  webId: string;
  email: string;
  password: string;
  verified: boolean;
};

type Settings = {
  useIdp: boolean;
  podBaseUrl?: string;
  clientCredentials?: string[];
};

type ClientCredentials = {
  webId: string;
  secret: string;
};

const STORAGE_DESCRIPTION = {
  [ACCOUNT_TYPE]: ACCOUNT_STORAGE_DESCRIPTION,
  [PASSWORD_STORAGE_TYPE]: PASSWORD_STORAGE_DESCRIPTION,
  [WEBID_STORAGE_TYPE]: WEBID_STORAGE_DESCRIPTION,
  [POD_STORAGE_TYPE]: POD_STORAGE_DESCRIPTION,
  [OWNER_STORAGE_TYPE]: OWNER_STORAGE_DESCRIPTION,
  [CLIENT_CREDENTIALS_STORAGE_TYPE]: CLIENT_CREDENTIALS_STORAGE_DESCRIPTION,
} as const;

export interface V6MigrationInitializerArgs {
  /**
   * The storage in which the version is saved that was stored last time the server was started.
   */
  versionStorage: KeyValueStorage<string, string>;
  /**
   * The key necessary to get the version from the `versionStorage`.
   */
  versionKey: string;
  /**
   * The storage in which account data of the previous version is stored.
   */
  accountStorage: KeyValueStorage<string, Account | Settings>;
  /**
   * The storage in which client credentials are stored from the previous version.
   */
  clientCredentialsStorage: KeyValueStorage<string, ClientCredentials>;
  /**
   * Storages for which all entries need to be removed.
   */
  cleanupStorages: KeyValueStorage<string, any>[];
  /**
   * The storage that will contain the account data in the new format.
   */
  newStorage: AccountLoginStorage<any>;
  /**
   * If true, no confirmation prompt will be printed to the stdout.
   */
  skipConfirmation?: boolean;
}

/**
 * Handles migrating account data from v6 to the newer format.
 * Will only trigger if it is detected that this server was previously started on an older version
 * and at least one account was found.
 * Confirmation will be asked to the user through a CLI prompt.
 * After migration is complete the old data will be removed.
 */
export class V6MigrationInitializer extends Initializer {
  private readonly logger = getLoggerFor(this);

  private readonly skipConfirmation: boolean;

  private readonly versionKey: string;
  private readonly versionStorage: KeyValueStorage<string, string>;

  private readonly accountStorage: KeyValueStorage<string, Account | Settings>;
  private readonly clientCredentialsStorage: KeyValueStorage<string, ClientCredentials>;
  private readonly cleanupStorages: KeyValueStorage<string, any>[];

  private readonly newStorage: AccountLoginStorage<typeof STORAGE_DESCRIPTION>;

  public constructor(args: V6MigrationInitializerArgs) {
    super();
    this.skipConfirmation = Boolean(args.skipConfirmation);
    this.versionKey = args.versionKey;
    this.versionStorage = args.versionStorage;
    this.accountStorage = args.accountStorage;
    this.clientCredentialsStorage = args.clientCredentialsStorage;
    this.cleanupStorages = args.cleanupStorages;
    this.newStorage = args.newStorage;
  }

  public async handle(): Promise<void> {
    const previousVersion = await this.versionStorage.get(this.versionKey);
    if (!previousVersion) {
      // This happens if this is the first time the server is started
      this.logger.debug('No previous version found');
      return;
    }

    const [ prevMajor ] = previousVersion.split('.');
    if (Number.parseInt(prevMajor, 10) > 6) {
      return;
    }

    // Ask the user for confirmation
    if (!this.skipConfirmation) {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve): void => {
        readline.question([
          'The server is now going to migrate v6 data to the new storage format internally.',
          'Existing accounts will be migrated.',
          'All other internal data, such as notification subscriptions will be removed.',
          'In case you have not yet done this,',
          'it is recommended to cancel startup and first backup the existing data,',
          'in case something goes wrong.',
          'When using default configurations with a file backend,',
          'this data can be found in the ".internal" folder.',
          '\n\nDo you want to migrate the data now? [y/N] ',
        ].join(' '), resolve);
      });
      readline.close();
      if (!/^y(?:es)?$/ui.test(answer)) {
        throw new Error('Stopping server as migration was cancelled.');
      }
    }

    this.logger.info('Migrating v6 data...');

    const webIdAccountMap: Record<string, string> = {};

    for await (const [ , account ] of this.accountStorage.entries()) {
      const result = await this.createAccount(account);
      if (result) {
        // Store link between WebID and account ID for client credentials
        webIdAccountMap[result.webId] = result.accountId;
      }
    }

    this.logger.debug('Converting client credentials tokens.');
    // Convert the existing client credentials tokens
    for await (const [ label, { webId, secret }] of this.clientCredentialsStorage.entries()) {
      const accountId = webIdAccountMap[webId];
      if (!accountId) {
        this.logger.warn(`Unable to find account for client credentials ${label}. Skipping migration of this token.`);
        continue;
      }
      await this.newStorage.create(CLIENT_CREDENTIALS_STORAGE_TYPE, { webId, label, secret, accountId });
    }

    // Cleanup all old entries
    this.logger.debug('Cleaning up older entries.');
    for (const storage of this.cleanupStorages) {
      for await (const [ key ] of storage.entries()) {
        await storage.delete(key);
      }
    }

    this.logger.info('Finished migrating v6 data.');
  }

  protected isAccount(data: Account | Settings): data is Account {
    return Boolean((data as Account).email);
  }

  /**
   * Creates a new account based on the account data found in the old storage.
   * Will always create an account and password entry.
   * In case `useIdp` is true, will create a WebID link entry.
   * In case there is an associated `podBaseUrl`, will create a pod and owner entry.
   */
  protected async createAccount(account: Account | Settings):
  Promise<{ accountId: string; webId: string } | undefined> {
    if (!this.isAccount(account)) {
      return;
    }

    const { webId, email, password, verified } = account;

    this.logger.debug(`Migrating account ${email} with WebID ${webId}`);

    const settings = await this.accountStorage.get(webId) as Settings | undefined;
    if (!settings) {
      this.logger.warn(`Unable to find settings for account ${email}. Skipping migration of this account.`);
      return;
    }

    const { id: accountId } = await this.newStorage.create(ACCOUNT_TYPE, {});
    // The `toLowerCase` call is important here to have the expected value
    await this.newStorage.create(PASSWORD_STORAGE_TYPE,
      { email: email.toLowerCase(), password, verified, accountId });
    if (settings.useIdp) {
      await this.newStorage.create(WEBID_STORAGE_TYPE, { webId, accountId });
    }
    if (settings.podBaseUrl) {
      const { id: podId } = await this.newStorage.create(POD_STORAGE_TYPE,
        { baseUrl: settings.podBaseUrl, accountId });
      await this.newStorage.create(OWNER_STORAGE_TYPE, { webId, podId, visible: false });
    }

    return { accountId, webId };
  }
}
