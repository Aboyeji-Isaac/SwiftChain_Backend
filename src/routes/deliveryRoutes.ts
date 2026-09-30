import { Router } from 'express';
import { deliveryController } from '../controllers/delivery.controller';

const router = Router();

router.get('/:id/eta', deliveryController.getDeliveryETA);

export default router;
