import {Controller, Delete, Get, Middleware, Post} from '@overnightjs/core';
import {DomainSchemas, UtilitySchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';

import {redis} from '../database/redis.js';
import {NotAllowed, NotFound} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {DomainService} from '../services/DomainService.js';
import {Keys} from '../services/keys.js';
import {MembershipService} from '../services/MembershipService.js';
import {SecurityService} from '../services/SecurityService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

@Controller('domains')
export class Domains {
  /**
   * Get all domains for a project
   */
  @Get('project/:projectId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getProjectDomains(_req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const domains = await DomainService.getProjectDomains(auth.projectId!);

    return res.status(200).json(domains);
  }

  /**
   * Add a new domain to a project
   */
  @Post('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async addDomain(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {domain} = DomainSchemas.create.parse(req.body);
    const projectId = auth.projectId!;

    // Require admin role for JWT users (API keys bypass — project-scoped by design)
    if (auth.type === 'jwt') {
      await MembershipService.requireAdminAccess(auth.userId!, projectId);
    }

    // Block domain changes on disabled projects
    const isDisabled = await SecurityService.isProjectDisabled(projectId);
    if (isDisabled) {
      throw new NotAllowed(
        'This project has been disabled. Please contact support for assistance.',
      );
    }

    // Block subdomains whose root domain belongs to a disabled project
    const rootCheck = await DomainService.checkSubdomainOfDisabledRoot(domain);
    if (rootCheck.blocked) {
      throw new NotAllowed(
        'This domain cannot be added at this time. Please contact support for assistance.',
      );
    }

    // Check if domain is already linked to another project
    const ownershipCheck = await DomainService.checkDomainOwnership(domain, auth.userId);

    if (ownershipCheck.exists) {
      if (ownershipCheck.projectId === projectId) {
        return res.status(400).json({
          error: 'This domain is already linked to this project.',
        });
      }

      // If domain exists and user is a member of that project, allow it
      if (ownershipCheck.isMember) {
        return res.status(400).json({
          error: `This domain is already linked to project "${ownershipCheck.projectName}". You are a member of that project, so you can use the domain from there.`,
        });
      }

      // Domain exists but user is not a member - deny access
      return res.status(403).json({
        error: 'This domain is already linked to another project. Only members of that project can use this domain.',
      });
    }

    try {
      const newDomain = await DomainService.addDomain(projectId, domain);

      await redis.del(Keys.Domain.project(projectId));

      return res.status(201).json(newDomain);
    } catch (error) {
      if (error instanceof Error) {
        return res.status(400).json({error: error.message});
      }
      throw error;
    }
  }

  /**
   * Check verification status for a domain
   */
  @Get(':id/verify')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async checkVerification(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);

    const domain = await DomainService.id(id);

    if (!domain || domain.projectId !== auth.projectId) {
      throw new NotFound('Domain not found');
    }

    const verificationStatus = await DomainService.checkVerification(id);

    // Invalidate cache if status changed
    await redis.del(Keys.Domain.id(id));
    await redis.del(Keys.Domain.project(domain.projectId));

    return res.status(200).json(verificationStatus);
  }

  /**
   * Remove a domain from a project
   */
  @Delete(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async removeDomain(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);

    const domain = await DomainService.id(id);

    if (!domain || domain.projectId !== auth.projectId) {
      throw new NotFound('Domain not found');
    }

    // Require admin role for JWT users (API keys bypass — project-scoped by design)
    if (auth.type === 'jwt') {
      await MembershipService.requireAdminAccess(auth.userId!, domain.projectId);
    }

    // Block domain changes on disabled projects
    const isDisabled = await SecurityService.isProjectDisabled(domain.projectId);
    if (isDisabled) {
      throw new NotAllowed(
        'This project has been disabled. Please contact support for assistance.',
      );
    }

    await DomainService.removeDomain(id);

    await redis.del(Keys.Domain.id(id));
    await redis.del(Keys.Domain.project(domain.projectId));

    return res.status(200).json({success: true});
  }
}
