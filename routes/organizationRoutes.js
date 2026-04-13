const express = require('express');
const authController = require('../controllers/authController');
const organizationController = require('../controllers/organizationController');

const router = express.Router();

router.post('/', authController.isAdmin, organizationController.createOrganization);
router.get('/', authController.protect, organizationController.getOrganizations);
router.put('/:id', authController.isAdmin, organizationController.updateOrganization);
router.post(
  '/redeem-code',
  authController.protect,
  organizationController.redeemOrganizationCode,
);
router.get(
  '/my-therapist-roster',
  authController.protect,
  organizationController.getMyTherapistRoster,
);

module.exports = router;
