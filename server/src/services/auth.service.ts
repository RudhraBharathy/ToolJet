import {
  BadRequestException,
  Injectable,
  NotAcceptableException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { OrganizationsService } from './organizations.service';
import { JwtService } from '@nestjs/jwt';
import { User } from '../entities/user.entity';
import { OrganizationUsersService } from './organization_users.service';
import { EmailService } from './email.service';
import { decamelizeKeys } from 'humps';
import { AuditLoggerService } from './audit_logger.service';
import { ActionTypes, ResourceTypes } from 'src/entities/audit_log.entity';
import got from 'got';
import { Organization } from 'src/entities/organization.entity';
import { ConfigService } from '@nestjs/config';
import { SSOConfigs } from 'src/entities/sso_config.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrganizationUser } from 'src/entities/organization_user.entity';
import { CreateUserDto } from '@dto/user.dto';
import { AcceptInviteDto } from '@dto/accept-organization-invite.dto';
const bcrypt = require('bcrypt');
const uuid = require('uuid');
const { TrackClient, RegionUS } = require('customerio-node');
const freshdeskBaseUrl = 'https://tooljet-417912114917301615.myfreshworks.com/crm/sales/api/';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(OrganizationUser)
    private organizationUsersRepository: Repository<OrganizationUser>,
    @InjectRepository(Organization)
    private organizationsRepository: Repository<Organization>,
    private usersService: UsersService,
    private jwtService: JwtService,
    private organizationsService: OrganizationsService,
    private organizationUsersService: OrganizationUsersService,
    private emailService: EmailService,
    private auditLoggerService: AuditLoggerService,
    private configService: ConfigService
  ) {}

  verifyToken(token: string) {
    try {
      const signedJwt = this.jwtService.verify(token);
      return signedJwt;
    } catch (err) {
      return null;
    }
  }

  private async validateUser(email: string, password: string, organizationId?: string): Promise<User> {
    const user = await this.usersService.findByEmail(email, organizationId);

    if (!user) return null;

    const isVerified = await bcrypt.compare(password, user.password);

    return isVerified ? user : null;
  }

  async login(request: any, email: string, password: string, organizationId?: string) {
    let organization: Organization;

    const user = await this.validateUser(email, password, organizationId);

    if (user && (await this.usersService.status(user)) !== 'archived') {
      if (!organizationId) {
        // Global login
        // Determine the organization to be loaded
        if (this.configService.get<string>('DISABLE_MULTI_WORKSPACE') === 'true') {
          // Single organization
          organization = await this.organizationsService.getSingleOrganization();
          if (!organization?.ssoConfigs?.find((oc) => oc.sso == 'form' && oc.enabled)) {
            throw new UnauthorizedException();
          }
        } else {
          const organizationList: Organization[] = await this.organizationsService.findOrganizationSupportsFormLogin(
            user
          );

          const defaultOrgDetails: Organization = organizationList?.find((og) => og.id === user.defaultOrganizationId);
          // Multi organization
          if (defaultOrgDetails) {
            // default organization form login enabled
            organization = defaultOrgDetails;
          } else if (organizationList?.length > 0) {
            // default organization form login not enabled, picking first one from form enabled list
            organization = organizationList[0];
          } else {
            // no form login enabled organization available for user - creating new one
            organization = await this.organizationsService.create('Untitled workspace', user);
          }
        }
        user.organizationId = organization.id;
      } else {
        // organization specific login
        user.organizationId = organizationId;

        organization = await this.organizationsService.get(user.organizationId);
        const formConfigs: SSOConfigs = organization?.ssoConfigs?.find((sso) => sso.sso === 'form');

        if (!formConfigs?.enabled) {
          // no configurations in organization side or Form login disabled for the organization
          throw new UnauthorizedException('Password login is disabled for the organization');
        }
      }

      if (user.defaultOrganizationId !== user.organizationId) {
        // Updating default organization Id
        await this.usersService.updateDefaultOrganization(user, organization.id);
      }

      await this.auditLoggerService.perform({
        request,
        userId: user.id,
        organizationId: organization.id,
        resourceId: user.id,
        resourceType: ResourceTypes.USER,
        resourceName: user.email,
        actionType: ActionTypes.USER_LOGIN,
      });

      const payload = {
        username: user.id,
        sub: user.email,
        organizationId: user.organizationId,
        isPasswordLogin: true,
      };

      return decamelizeKeys({
        id: user.id,
        auth_token: this.jwtService.sign(payload),
        email: user.email,
        first_name: user.firstName,
        last_name: user.lastName,
        avatar_id: user.avatarId,
        organizationId: user.organizationId,
        organization: organization.name,
        admin: await this.usersService.hasGroup(user, 'admin'),
        group_permissions: await this.usersService.groupPermissions(user),
        app_group_permissions: await this.usersService.appGroupPermissions(user),
      });
    } else {
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  async createCRMUser(user): Promise<boolean> {
    await got('https://tooljet-417912114917301615.myfreshworks.com/crm/sales/api/contacts', {
      method: 'post',
      headers: { Authorization: `Token token=${process.env.FWAPIKey}`, 'Content-Type': 'application/json' },
      json: {
        contact: {
          email: user.email,
          first_name: user.firstName,
          last_name: user.lastName,
          custom_field: {
            job_title: user.role,
          },
        },
      },
    });

    return true;
  }

  async switchOrganization(newOrganizationId: string, user: User, isNewOrganization?: boolean) {
    if (!(isNewOrganization || user.isPasswordLogin)) {
      throw new UnauthorizedException();
    }
    if (this.configService.get<string>('DISABLE_MULTI_WORKSPACE') === 'true') {
      throw new UnauthorizedException();
    }
    const newUser = await this.usersService.findByEmail(user.email, newOrganizationId);

    if (newUser && (await this.usersService.status(newUser)) !== 'archived') {
      newUser.organizationId = newOrganizationId;

      const organization: Organization = await this.organizationsService.get(newUser.organizationId);

      const formConfigs: SSOConfigs = organization?.ssoConfigs?.find((sso) => sso.sso === 'form');

      if (!formConfigs?.enabled) {
        // no configurations in organization side or Form login disabled for the organization
        throw new UnauthorizedException('Password login disabled for the organization');
      }

      // Updating default organization Id
      await this.usersService.updateDefaultOrganization(newUser, newUser.organizationId);

      const payload = {
        username: user.id,
        sub: user.email,
        organizationId: newUser.organizationId,
        isPasswordLogin: true,
      };

      return decamelizeKeys({
        id: newUser.id,
        auth_token: this.jwtService.sign(payload),
        email: newUser.email,
        first_name: newUser.firstName,
        last_name: newUser.lastName,
        organizationId: newUser.organizationId,
        organization: organization.name,
        admin: await this.usersService.hasGroup(newUser, 'admin'),
        group_permissions: await this.usersService.groupPermissions(newUser),
        app_group_permissions: await this.usersService.appGroupPermissions(newUser),
      });
    } else {
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  async signup(request: any, email: string) {
    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser?.organizationUsers?.some((ou) => ou.status === 'active')) {
      throw new NotAcceptableException('Email already exists');
    }

    if (existingUser?.invitationToken) {
      await this.emailService.sendWelcomeEmail(
        existingUser.email,
        existingUser.firstName,
        existingUser.invitationToken
      );
      return;
    }

    let organization: Organization;
    // Check if the configs allows user signups
    if (this.configService.get<string>('DISABLE_MULTI_WORKSPACE') === 'true') {
      // Single organization checking if organization exist
      organization = await this.organizationsService.getSingleOrganization();

      if (organization) {
        throw new NotAcceptableException('Multi organization not supported - organization exist');
      }
    } else {
      // Multi organization
      if (this.configService.get<string>('DISABLE_SIGNUPS') === 'true') {
        throw new NotAcceptableException();
      }
    }
    // Create default organization
    organization = await this.organizationsService.create('Untitled workspace');
    const user = await this.usersService.create({ email }, organization.id, ['all_users', 'admin'], existingUser, true);
    await this.organizationUsersService.create(user, organization, true);
    await this.emailService.sendWelcomeEmail(user.email, user.firstName, user.invitationToken);

    const cio = new TrackClient(process.env.customerIoSiteId, process.env.customerIoApiKey, { region: RegionUS });

    cio.identify(user.email, {
      email: user.email,
      created_at: Math.round(+new Date() / 1000),
      first_name: user.firstName,
      last_name: user.lastName,
    });

    void this.createCRMUser(user);

    await this.auditLoggerService.perform({
      request,
      userId: user.id,
      organizationId: organization.id,
      resourceId: user.id,
      resourceType: ResourceTypes.USER,
      resourceName: user.email,
      actionType: ActionTypes.USER_SIGNUP,
    });

    return {};
  }

  async forgotPassword(email: string) {
    const user = await this.usersService.findByEmail(email);
    const forgotPasswordToken = uuid.v4();
    await this.usersService.update(user.id, { forgotPasswordToken });
    await this.emailService.sendPasswordResetEmail(email, forgotPasswordToken);
  }

  async resetPassword(token: string, password: string) {
    const user = await this.usersService.findByPasswordResetToken(token);
    if (!user) {
      throw new NotFoundException('Invalid token');
    } else {
      await this.usersService.update(user.id, {
        password,
        forgotPasswordToken: null,
      });
    }
  }

  async setupAccountFromInvitationToken(request: any, userCreateDto: CreateUserDto) {
    const {
      organization,
      password,
      token,
      role,
      first_name: firstName,
      last_name: lastName,
      organizationToken,
    } = userCreateDto;

    if (!token) {
      throw new BadRequestException('Invalid token');
    }

    const user: User = await this.usersRepository.findOne({ where: { invitationToken: token } });

    if (!user?.organizationUsers) {
      throw new BadRequestException('Invalid invitation link');
    }
    const organizationUser: OrganizationUser = user.organizationUsers.find(
      (ou) => ou.organizationId === user.defaultOrganizationId
    );

    if (!organizationUser) {
      throw new BadRequestException('Invalid invitation link');
    }

    await this.usersRepository.save(
      Object.assign(user, {
        firstName,
        lastName,
        password,
        role,
        invitationToken: null,
      })
    );

    await this.organizationUsersRepository.save(
      Object.assign(organizationUser, {
        invitationToken: null,
        status: 'active',
      })
    );

    if (organization) {
      await this.organizationsRepository.update(user.defaultOrganizationId, {
        name: organization,
      });
    }

    if (this.configService.get<string>('DISABLE_MULTI_WORKSPACE') !== 'true' && organizationToken) {
      const organizationUser = await this.organizationUsersRepository.findOne({
        where: { invitationToken: organizationToken },
      });

      if (organizationUser) {
        await this.organizationUsersRepository.save(
          Object.assign(organizationUser, {
            invitationToken: null,
            status: 'active',
          })
        );
      }
    }

    await this.auditLoggerService.perform({
      request,
      userId: user.id,
      organizationId: organizationUser.organizationId,
      resourceId: user.id,
      resourceName: user.email,
      resourceType: ResourceTypes.USER,
      actionType: ActionTypes.USER_INVITE_REDEEM,
    });
  }

  async updateCRM(user: User): Promise<boolean> {
    const response = await got(`${freshdeskBaseUrl}lookup?q=${user.email}&f=email&entities=contact`, {
      method: 'get',
      headers: {
        Authorization: `Token token=${process.env.FWAPIKey}`,
        'Content-Type': 'application/json',
      },
    });

    const contacts = JSON.parse(response.body)['contacts']['contacts'];
    let contact = undefined;

    if (contacts) {
      if (contacts.length > 0) {
        contact = contacts[0];
      }
    }

    await got(`${freshdeskBaseUrl}contacts/${contact.id}`, {
      method: 'put',
      headers: { Authorization: `Token token=${process.env.FWAPIKey}`, 'Content-Type': 'application/json' },
      json: {
        contact: {
          email: user.email,
          first_name: user.firstName,
          last_name: user.lastName,
          custom_field: {
            job_title: user.role,
          },
        },
      },
    });

    return true;
  }

  async acceptOrganizationInvite(request: any, acceptInviteDto: AcceptInviteDto) {
    const { password, token } = acceptInviteDto;

    if (this.configService.get<string>('DISABLE_MULTI_WORKSPACE') === 'true' && !password) {
      throw new BadRequestException('Please enter password');
    }
    const organizationUser = await this.organizationUsersRepository.findOne({
      where: { invitationToken: token },
      relations: ['user'],
    });

    if (!organizationUser?.user) {
      throw new BadRequestException('Invalid invitation link');
    }
    const user: User = organizationUser.user;

    if (this.configService.get<string>('DISABLE_MULTI_WORKSPACE') !== 'true' && user.invitationToken) {
      // User sign up link send - not activated account
      this.emailService
        .sendWelcomeEmail(
          user.email,
          `${user.firstName} ${user.lastName}`,
          user.invitationToken,
          organizationUser.invitationToken
        )
        .catch((err) => console.error('Error while sending welcome mail', err));

      void this.updateCRM(user);

      throw new UnauthorizedException(
        'User not exist in the workspace, Please setup your account using link shared via email'
      );
    }

    if (this.configService.get<string>('DISABLE_MULTI_WORKSPACE') === 'true') {
      // set new password
      await this.usersRepository.save(
        Object.assign(user, {
          ...(password ? { password } : {}),
          invitationToken: null,
        })
      );
    }

    await this.organizationUsersRepository.save(
      Object.assign(organizationUser, {
        invitationToken: null,
        status: 'active',
      })
    );

    await this.auditLoggerService.perform({
      request,
      userId: user.id,
      organizationId: organizationUser.organizationId,
      resourceId: user.id,
      resourceName: user.email,
      resourceType: ResourceTypes.USER,
      actionType: ActionTypes.USER_INVITE_REDEEM,
    });
  }
}
