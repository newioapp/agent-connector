import { Router, Request, Response, NextFunction } from 'express';
import { Express } from 'express';
import { Endpoints } from './endpoints';
import { ContactService } from '../services/contact-service';
import { requireAuth, requireUsername, requireWriteAccess, getAuthContext } from '../middleware/auth-middleware';
import { InvalidRequestError } from '../utils/errors';
import { MAX_FRIEND_NAME_LENGTH, MAX_FRIEND_REQUEST_NOTE_LENGTH, MAX_PAGE_SIZE } from '../utils/validation-constants';
import { getLogger } from '../utils/logger';

const logger = getLogger('contact-endpoints');

export class ContactEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(contactService: ContactService) {
    this.router = Router();

    // GET /contacts — list friends
    this.router.get(
      '/contacts',
      requireAuth,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { userId } = getAuthContext(req);
          const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
          const limit = req.query.limit ? Math.min(Number(req.query.limit), MAX_PAGE_SIZE) : undefined;
          logger.info(`GET /contacts — userId=${userId}.`);
          const result = await contactService.listFriends({ userId, cursor, limit });
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    // POST /contacts/requests — send friend request
    this.router.post(
      '/contacts/requests',
      requireAuth,
      requireWriteAccess,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { userId } = getAuthContext(req);
          const { contactId, note } = req.body;
          if (!contactId || typeof contactId !== 'string') {
            throw new InvalidRequestError('Missing or invalid "contactId" in request body.');
          }
          if (note !== undefined && typeof note !== 'string') {
            throw new InvalidRequestError('"note" must be a string.');
          }
          if (typeof note === 'string' && note.length > MAX_FRIEND_REQUEST_NOTE_LENGTH) {
            throw new InvalidRequestError(`"note" must be ${MAX_FRIEND_REQUEST_NOTE_LENGTH} characters or fewer.`);
          }
          logger.info(`POST /contacts/requests — userId=${userId}, contactId=${contactId}.`);
          const result = await contactService.sendFriendRequest({ userId, contactId, note });
          res.status(201).json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    // GET /contacts/requests — list incoming friend requests
    this.router.get(
      '/contacts/requests',
      requireAuth,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { userId } = getAuthContext(req);
          const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
          const limit = req.query.limit ? Math.min(Number(req.query.limit), MAX_PAGE_SIZE) : undefined;
          logger.info(`GET /contacts/requests — userId=${userId}.`);
          const result = await contactService.listIncomingRequests({ userId, cursor, limit });
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    // GET /contacts/requests/outgoing — list outgoing friend requests
    this.router.get(
      '/contacts/requests/outgoing',
      requireAuth,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { userId } = getAuthContext(req);
          const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
          const limit = req.query.limit ? Math.min(Number(req.query.limit), MAX_PAGE_SIZE) : undefined;
          logger.info(`GET /contacts/requests/outgoing — userId=${userId}.`);
          const result = await contactService.listOutgoingRequests({ userId, cursor, limit });
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    // DELETE /contacts/requests/outgoing/:contactId — revoke outgoing friend request
    this.router.delete(
      '/contacts/requests/outgoing/:contactId',
      requireAuth,
      requireWriteAccess,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { userId } = getAuthContext(req);
          const { contactId } = req.params;
          logger.info(`DELETE /contacts/requests/outgoing/${contactId} — userId=${userId}.`);
          await contactService.revokeOutgoingRequest({ userId, contactId });
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );

    // POST /contacts/requests/:requestId/accept
    this.router.post(
      '/contacts/requests/:requestId/accept',
      requireAuth,
      requireWriteAccess,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { userId } = getAuthContext(req);
          const { requestId } = req.params;
          const { onBehalfOf } = req.body;
          logger.info(
            `POST /contacts/requests/${requestId}/accept — userId=${userId}${onBehalfOf ? `, onBehalfOf=${onBehalfOf}` : ''}.`,
          );
          const result = await contactService.acceptFriendRequest({ userId, requestId, onBehalfOf });
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    // POST /contacts/requests/:requestId/reject
    this.router.post(
      '/contacts/requests/:requestId/reject',
      requireAuth,
      requireWriteAccess,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { userId } = getAuthContext(req);
          const { requestId } = req.params;
          const { onBehalfOf } = req.body;
          logger.info(
            `POST /contacts/requests/${requestId}/reject — userId=${userId}${onBehalfOf ? `, onBehalfOf=${onBehalfOf}` : ''}.`,
          );
          await contactService.rejectFriendRequest({ userId, requestId, onBehalfOf });
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );

    // PUT /contacts/:contactId — update friend name
    this.router.put(
      '/contacts/:contactId',
      requireAuth,
      requireWriteAccess,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { userId } = getAuthContext(req);
          const { contactId } = req.params;
          const { friendName } = req.body;
          if (!friendName || typeof friendName !== 'string') {
            throw new InvalidRequestError('Missing or invalid "friendName" in request body.');
          }
          if (friendName.trim().length > MAX_FRIEND_NAME_LENGTH) {
            throw new InvalidRequestError(`"friendName" must be ${MAX_FRIEND_NAME_LENGTH} characters or fewer.`);
          }
          logger.info(`PUT /contacts/${contactId} — userId=${userId}.`);
          const result = await contactService.updateFriendName({ userId, contactId, friendName });
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    // DELETE /contacts/:userId — remove friend
    this.router.delete(
      '/contacts/:userId',
      requireAuth,
      requireWriteAccess,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const auth = getAuthContext(req);
          const contactId = req.params.userId;
          logger.info(`DELETE /contacts/${contactId} — userId=${auth.userId}.`);
          await contactService.removeFriend({ userId: auth.userId, contactId });
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );

    // POST /blocks/:userId — block user
    this.router.post(
      '/blocks/:userId',
      requireAuth,
      requireWriteAccess,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const auth = getAuthContext(req);
          const blockedUserId = req.params.userId;
          logger.info(`POST /blocks/${blockedUserId} — userId=${auth.userId}.`);
          const result = await contactService.blockUser({ userId: auth.userId, blockedUserId });
          res.status(201).json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    // DELETE /blocks/:userId — unblock user
    this.router.delete(
      '/blocks/:userId',
      requireAuth,
      requireWriteAccess,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const auth = getAuthContext(req);
          const blockedUserId = req.params.userId;
          logger.info(`DELETE /blocks/${blockedUserId} — userId=${auth.userId}.`);
          await contactService.unblockUser({ userId: auth.userId, blockedUserId });
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );

    // GET /blocks — list blocked users
    this.router.get(
      '/blocks',
      requireAuth,
      requireUsername,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { userId } = getAuthContext(req);
          logger.info(`GET /blocks — userId=${userId}.`);
          const blocks = await contactService.listBlocks({ userId });
          res.status(200).json(blocks);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
