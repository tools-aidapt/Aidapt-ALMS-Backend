'use strict';

const express = require('express');
const ctrl = require('../controllers/uploadController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Serve must accept optional auth: photos are UUID-gated; CNIC requires Bearer.
// When Authorization is present we attach req.user so CNIC ACL can run.
router.get('/:id', (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return ctrl.serve(req, res, next);
  return authenticate(req, res, (err) => {
    if (err) return next(err);
    return ctrl.serve(req, res, next);
  });
});

router.post('/', authenticate, ctrl.uploadMiddleware, ctrl.create);

module.exports = router;
