'use strict';

const Employee = require('../models/Employee');
const { ROLES } = require('../middleware/auth');
const { forbidden, notFound } = require('../middleware/errorHandler');
const { hasCompanyWideDataAccess } = require('./leadershipAccess');

/**
 * Resolve the single employee id a "My Records"-style list endpoint may return.
 *
 * Contract (caller always from bearer token):
 * - employeeId omitted or = self → caller's own id (every role)
 * - employeeId = another employee:
 *     Employee  → 403 (unless Leadership)
 *     Manager   → allowed only if target reports to caller, else 403
 *     HR Admin / Leadership team → allowed
 *
 * Always returns exactly one employee id. Never "everyone".
 *
 * @param {{id: string, role: string, isLeadership?: boolean}} caller
 * @param {string|undefined|null} requestedEmployeeId
 * @param {{getEmployee?: (id: string) => Promise<object|null>}} [deps] test seam
 * @returns {Promise<string>}
 */
async function resolveEmployeeRecordScope(caller, requestedEmployeeId, deps = {}) {
  const getEmployee = deps.getEmployee || ((id) => Employee.get(id));
  const requested = requestedEmployeeId ? String(requestedEmployeeId) : '';

  if (!requested || requested === caller.id) {
    return caller.id;
  }

  // HR Admin and Leadership: any employee.
  if (hasCompanyWideDataAccess(caller)) {
    const target = await getEmployee(requested);
    if (!target) throw notFound('Employee not found');
    return requested;
  }

  if (caller.role === ROLES.EMPLOYEE) {
    throw forbidden('Not your records');
  }

  if (caller.role === ROLES.MANAGER) {
    const target = await getEmployee(requested);
    if (!target) throw notFound('Employee not found');
    if (!(target.fields.Manager || []).includes(caller.id)) {
      throw forbidden('Not one of your reports');
    }
    return requested;
  }

  throw forbidden();
}

module.exports = { resolveEmployeeRecordScope };
