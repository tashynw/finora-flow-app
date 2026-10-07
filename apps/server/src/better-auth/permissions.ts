import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access';

const statement = {
  ...defaultStatements,
} as const;

export const ac = createAccessControl(statement);

/** Full Better Auth admin capabilities. */
export const administrator = ac.newRole({
  ...adminAc.statements,
});

/** App roles with no Better Auth admin API access. */
export const requester = ac.newRole({
  user: [],
  session: [],
});

export const approver = ac.newRole({
  user: [],
  session: [],
});

export const payment_coordinator = ac.newRole({
  user: [],
  session: [],
});

export const finance = ac.newRole({
  user: [],
  session: [],
});

export const operations = ac.newRole({
  user: [],
  session: [],
});

export const auditor = ac.newRole({
  user: [],
  session: [],
});

export const finoraRoles = {
  administrator,
  requester,
  approver,
  payment_coordinator,
  finance,
  operations,
  auditor,
};
