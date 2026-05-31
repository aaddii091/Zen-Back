const express = require('express');
const authController = require('../controllers/authController');
const adminController = require('../controllers/adminController');

const router = express.Router();

router.use(authController.protect, authController.isAdmin);

router.get('/organizations', adminController.listOrganizations);
router.post('/organizations', adminController.createOrganization);
router.get('/organizations/:id', adminController.getOrganizationDetail);
router.patch('/organizations/:id', adminController.updateOrganization);
router.delete('/organizations/:id', adminController.deleteOrganization);
router.post('/organizations/:id/invite-code/generate', adminController.generateOrganizationInviteCode);
router.post('/organizations/:id/invite-code/revoke', adminController.revokeOrganizationInviteCode);
router.post('/organizations/:id/roster/add', adminController.addRosterMember);
router.post('/organizations/:id/roster/remove', adminController.removeRosterMember);
router.get('/organizations/:id/users', adminController.listOrganizationUsers);
router.get('/organizations/:id/import-jobs', adminController.listOrganizationImportJobs);
router.get('/organizations/:id/audit-logs', adminController.listOrganizationAuditLogs);

router.get('/users', adminController.listUsers);
router.post('/users', adminController.createUser);
router.patch('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.deleteUser);
router.post('/users/:id/suspend', adminController.suspendUser);
router.post('/users/:id/reassign-support', adminController.reassignSupport);
router.post('/users/:id/force-logout', adminController.forceLogout);
router.post('/users/:id/reset-password', adminController.resetUserPassword);
router.post('/users/:id/impersonate', adminController.impersonateUser);

router.post('/imports/students', adminController.uploadStudentsCsv, adminController.createStudentImportJob);
router.get('/imports/students', adminController.listStudentImportJobs);
router.get('/imports/students/:id', adminController.getStudentImportJob);

router.get('/audit-logs', adminController.listAuditLogs);

module.exports = router;
